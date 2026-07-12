import { createHash } from "node:crypto";
import { interpolateMood, MOOD_VECTORS, normalizeMood } from "./moods.js";
import { CANONICAL_MOODS } from "./types.js";
import type { ExternalMusicCandidate, LiveJourney, LiveJourneyTrack, TasteProfile } from "./liveTypes.js";
import type { CanonicalMood, MoodVector, Phase } from "./types.js";

const PHASES: readonly Phase[] = ["mirror", "bridge", "arrive"];
const PHASE_PROGRESS: Record<Phase, number> = {
  mirror: 0.08,
  bridge: 0.52,
  arrive: 0.94
};
const PHASE_TIME_WEIGHT: Record<Phase, number> = {
  mirror: 0.25,
  bridge: 0.4,
  arrive: 0.35
};
const DEFAULT_DURATION_SEC = 210;
const MAX_CANDIDATES = 100;
const MAX_TRACKS = 18;
// A narrow beam is enough because phase progress is monotonic and candidates are
// already scored independently. Keeping it bounded also protects MCP latency
// when a provider returns the allowed maximum of 100 candidates.
const BEAM_WIDTH = 24;
const NEUTRAL_VECTOR: MoodVector = { valence: 0.5, energy: 0.5, acousticness: 0.5 };

const MOOD_TERMS: Record<CanonicalMood, readonly string[]> = {
  calm: ["calm", "chill", "relax", "relaxed", "peaceful", "serene", "ambient", "meditation", "acoustic", "quiet", "차분", "잔잔"],
  content: ["content", "comfortable", "cozy", "easy listening", "warm", "soft pop", "편안", "포근"],
  sad: ["sad", "melancholy", "melancholic", "heartbreak", "sorrow", "blues", "sad ballad", "슬픔", "우울"],
  anxious: ["anxious", "anxiety", "tense", "tension", "nervous", "restless", "stress", "불안", "긴장"],
  tired: ["tired", "sleepy", "sleep", "downtempo", "slow", "dreamy", "dream pop", "lo-fi", "lofi", "지침", "나른"],
  focused: ["focused", "focus", "study", "concentration", "productivity", "minimal", "classical", "집중", "공부"],
  hopeful: ["hopeful", "hope", "uplifting", "inspiring", "inspirational", "encouraging", "anthemic", "희망", "용기"],
  joyful: ["joyful", "joy", "happy", "cheerful", "feel good", "feel-good", "disco", "funk", "기쁨", "행복"],
  energetic: ["energetic", "energy", "workout", "running", "dance", "edm", "power", "upbeat", "활력", "운동"],
  angry: ["angry", "anger", "aggressive", "rage", "hardcore", "metal", "punk", "분노", "격정"],
  lonely: ["lonely", "loneliness", "solitude", "alone", "introspective", "indie folk", "외로움", "고독"],
  romantic: ["romantic", "romance", "love", "love song", "affection", "soul", "r&b", "설렘", "사랑"]
};

const REQUIRED_CANDIDATE_FIELDS = [
  "id",
  "title",
  "artist",
  "durationSec",
  "provider",
  "providerUrl",
  "tags or genres",
  "language",
  "instrumental",
  "personalizationScore",
  "liked",
  "recentPlayCount"
] as const;

const MELON_TOOLS_BY_PHASE: Record<Phase, readonly string[]> = {
  mirror: [
    "get_recently_played_music_contents",
    "get_my_liked_music_contents",
    "get_my_most_listened_songs",
    "recommend_personalized_songs_by_dj_mallang"
  ],
  bridge: [
    "recommend_similar_songs_by_dj_mallang",
    "recommend_personalized_songs_by_dj_mallang",
    "search_melon_music_contents"
  ],
  arrive: [
    "recommend_personalized_songs_by_dj_mallang",
    "search_melon_music_contents",
    "get_melon_curated_playlists"
  ]
};

export interface PlanLiveJourneyBriefOptions {
  currentMood: string;
  targetMood: string;
  minutes: number;
  weather?: string;
  activity?: string;
  tasteProfile?: TasteProfile;
}

export interface LivePhaseCandidateRequest {
  targetCount: number;
  requiredFields: readonly string[];
  preferredSources: Array<{
    provider: "official-melon-mcp" | "other-toolbox-music-provider";
    tools: readonly string[];
    instruction: string;
  }>;
}

export interface LiveJourneyPhaseBrief {
  phase: Phase;
  progress: number;
  allocatedSeconds: number;
  allocatedMinutes: number;
  targetVector: MoodVector;
  tags: string[];
  searchIntent: string;
  candidateRequest: LivePhaseCandidateRequest;
}

export interface LiveJourneyBrief {
  currentMood: CanonicalMood;
  targetMood: CanonicalMood;
  requestedMinutes: number;
  context: {
    weather?: string;
    activity?: string;
  };
  tasteProfile: TasteProfile;
  phases: LiveJourneyPhaseBrief[];
  orchestrationNote: string;
}

export interface RankExternalCandidatesOptions extends PlanLiveJourneyBriefOptions {
  excludedCandidateIds?: string[];
  candidateSource?: LiveJourney["candidateSource"];
}

interface InferredMood {
  vector: MoodVector;
  canonical: CanonicalMood;
  hasMoodSignal: boolean;
}

interface PreparedCandidate {
  candidate: ExternalMusicCandidate;
  stableKey: string;
  dedupeKey: string;
  artistKey: string;
  normalizedTags: string[];
  normalizedGenres: string[];
  effectiveDurationSec: number;
  inferred: InferredMood;
  pathProgress: number;
  targetDistance: number;
  personalization: number;
}

interface PlannedSlot {
  phase: Phase;
  progress: number;
  targetVector: MoodVector;
  idealDurationSec: number;
}

interface SelectionState {
  tracks: PreparedCandidate[];
  elapsedSec: number;
  score: number;
  usedKeys: Set<string>;
  artistCounts: Map<string, number>;
  lastProgress: number;
  lastTargetDistance: number;
}

function assertMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < 10 || minutes > 60) {
    throw new Error("minutes must be between 10 and 60");
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(value: number | undefined, fallback = 0): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function vectorDistance(a: MoodVector, b: MoodVector): number {
  return Math.sqrt(
    (a.valence - b.valence) ** 2 * 0.42 +
    (a.energy - b.energy) ** 2 * 0.42 +
    (a.acousticness - b.acousticness) ** 2 * 0.16
  );
}

function nearestCanonicalMood(vector: MoodVector): CanonicalMood {
  return [...CANONICAL_MOODS].sort((a, b) => {
    const distanceDifference = vectorDistance(vector, MOOD_VECTORS[a]) - vectorDistance(vector, MOOD_VECTORS[b]);
    return distanceDifference || a.localeCompare(b);
  })[0] ?? "content";
}

function inferMood(candidate: ExternalMusicCandidate): InferredMood {
  const rawTerms = [...(candidate.tags ?? []), ...(candidate.genres ?? [])]
    .map(normalizeText)
    .filter(Boolean);
  const weights = new Map<CanonicalMood, number>();

  for (const mood of CANONICAL_MOODS) {
    let weight = 0;
    for (const rawTerm of rawTerms) {
      if (rawTerm === mood) weight += 4;
      for (const term of MOOD_TERMS[mood]) {
        const normalizedTerm = normalizeText(term);
        if (rawTerm === normalizedTerm) weight += 2;
        else if (rawTerm.includes(normalizedTerm)) weight += 1;
      }
    }
    if (weight > 0) weights.set(mood, weight);
  }

  const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
  if (totalWeight === 0) {
    return {
      vector: { ...NEUTRAL_VECTOR },
      canonical: nearestCanonicalMood(NEUTRAL_VECTOR),
      hasMoodSignal: false
    };
  }

  const vector = [...weights.entries()].reduce<MoodVector>((result, [mood, weight]) => ({
    valence: result.valence + MOOD_VECTORS[mood].valence * weight / totalWeight,
    energy: result.energy + MOOD_VECTORS[mood].energy * weight / totalWeight,
    acousticness: result.acousticness + MOOD_VECTORS[mood].acousticness * weight / totalWeight
  }), { valence: 0, energy: 0, acousticness: 0 });

  return {
    vector,
    canonical: nearestCanonicalMood(vector),
    hasMoodSignal: true
  };
}

function pathProjection(vector: MoodVector, currentMood: CanonicalMood, targetMood: CanonicalMood): number {
  const from = MOOD_VECTORS[currentMood];
  const to = MOOD_VECTORS[targetMood];
  if (currentMood === targetMood) return -vectorDistance(vector, to);
  const delta = {
    valence: to.valence - from.valence,
    energy: to.energy - from.energy,
    acousticness: to.acousticness - from.acousticness
  };
  const denominator = delta.valence ** 2 + delta.energy ** 2 + delta.acousticness ** 2;
  if (denominator <= Number.EPSILON) return 0;
  return (
    (vector.valence - from.valence) * delta.valence +
    (vector.energy - from.energy) * delta.energy +
    (vector.acousticness - from.acousticness) * delta.acousticness
  ) / denominator;
}

function allocatePhaseSeconds(minutes: number): Record<Phase, number> {
  const totalSeconds = Math.round(minutes * 60);
  const mirror = Math.round(totalSeconds * PHASE_TIME_WEIGHT.mirror);
  const bridge = Math.round(totalSeconds * PHASE_TIME_WEIGHT.bridge);
  return {
    mirror,
    bridge,
    arrive: totalSeconds - mirror - bridge
  };
}

function vectorTags(vector: MoodVector): string[] {
  const valenceTag = vector.valence < 0.36 ? "reflective" : vector.valence > 0.7 ? "uplifting" : "balanced-valence";
  const energyTag = vector.energy < 0.34 ? "low-energy" : vector.energy > 0.7 ? "high-energy" : "mid-energy";
  const textureTag = vector.acousticness > 0.7 ? "acoustic" : vector.acousticness < 0.3 ? "electronic" : "balanced-texture";
  return [valenceTag, energyTag, textureTag];
}

function phaseSearchIntent(phase: Phase, currentMood: CanonicalMood, targetMood: CanonicalMood): string {
  if (phase === "mirror") {
    return `Find familiar or personally relevant tracks that acknowledge ${currentMood} without intensifying it.`;
  }
  if (phase === "bridge") {
    return `Find transitional tracks that gently move energy and valence from ${currentMood} toward ${targetMood}.`;
  }
  return `Find personally relevant tracks that sustain and land in ${targetMood}.`;
}

function buildPhaseTags(
  phase: Phase,
  currentMood: CanonicalMood,
  targetMood: CanonicalMood,
  vector: MoodVector,
  options: PlanLiveJourneyBriefOptions
): string[] {
  const tags = [
    phase === "mirror" ? currentMood : phase === "arrive" ? targetMood : `transition-${currentMood}-to-${targetMood}`,
    ...vectorTags(vector)
  ];
  if (options.weather?.trim()) tags.push(`weather:${normalizeText(options.weather)}`);
  if (options.activity?.trim()) tags.push(`activity:${normalizeText(options.activity)}`);
  for (const genre of options.tasteProfile?.favoriteGenres ?? []) {
    const normalized = normalizeText(genre);
    if (normalized) tags.push(`favorite-genre:${normalized}`);
  }
  if (options.tasteProfile?.instrumentalOnly || options.tasteProfile?.languagePreference === "instrumental") {
    tags.push("instrumental");
  }
  return [...new Set(tags)];
}

export function planLiveJourneyBrief(options: PlanLiveJourneyBriefOptions): LiveJourneyBrief {
  assertMinutes(options.minutes);
  const currentMood = normalizeMood(options.currentMood);
  const targetMood = normalizeMood(options.targetMood);
  const allocations = allocatePhaseSeconds(options.minutes);
  const tasteProfile = { ...(options.tasteProfile ?? {}) };

  const phases = PHASES.map((phase): LiveJourneyPhaseBrief => {
    const targetVector = interpolateMood(currentMood, targetMood, PHASE_PROGRESS[phase]);
    const tags = buildPhaseTags(phase, currentMood, targetMood, targetVector, options);
    const targetCount = Math.max(6, Math.min(20, Math.ceil(allocations[phase] / DEFAULT_DURATION_SEC) * 3));
    const tools = MELON_TOOLS_BY_PHASE[phase];
    const searchIntent = phaseSearchIntent(phase, currentMood, targetMood);
    return {
      phase,
      progress: PHASE_PROGRESS[phase],
      allocatedSeconds: allocations[phase],
      allocatedMinutes: round(allocations[phase] / 60, 2),
      targetVector,
      tags,
      searchIntent,
      candidateRequest: {
        targetCount,
        requiredFields: REQUIRED_CANDIDATE_FIELDS,
        preferredSources: [
          {
            provider: "official-melon-mcp",
            tools,
            instruction: `When the official Melon MCP is in the toolbox, use ${tools.join(", ")} to return about ${targetCount} real candidate tracks for the ${phase} phase. Preserve Melon IDs and URLs; do not scrape Melon.`
          },
          {
            provider: "other-toolbox-music-provider",
            tools: [],
            instruction: `Otherwise ask an authorized music provider for track metadata matching: ${tags.join(", ")}. Do not return audio or lyrics.`
          }
        ]
      }
    };
  });

  return {
    currentMood,
    targetMood,
    requestedMinutes: options.minutes,
    context: {
      ...(options.weather?.trim() ? { weather: options.weather.trim() } : {}),
      ...(options.activity?.trim() ? { activity: options.activity.trim() } : {})
    },
    tasteProfile,
    phases,
    orchestrationNote: "This server plans and ranks metadata supplied by authorized music tools. It does not proxy, scrape, or claim access to any provider catalog."
  };
}

function matchesTerm(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const normalized = normalizeText(term);
    return normalized.length > 0 && (value === normalized || value.includes(normalized));
  });
}

function genresMatch(candidateGenres: readonly string[], requestedGenres: readonly string[]): boolean {
  return candidateGenres.some((genre) => matchesTerm(genre, requestedGenres));
}

function isInstrumental(candidate: ExternalMusicCandidate, normalizedTerms: readonly string[]): boolean {
  return candidate.instrumental === true || normalizedTerms.some((term) => term.includes("instrumental") || term.includes("연주곡"));
}

function languageMatches(candidate: ExternalMusicCandidate, preference: TasteProfile["languagePreference"], instrumental: boolean): boolean {
  if (!preference || preference === "any") return true;
  if (preference === "instrumental") return instrumental;
  const language = normalizeText(candidate.language ?? "");
  if (!language) return false;
  const korean = language === "ko" || language === "kor" || language.includes("korean") || language.includes("한국어");
  return preference === "korean" ? korean : !korean;
}

function duplicateKey(candidate: ExternalMusicCandidate): string {
  if (candidate.recordingMbid?.trim()) return `mbid:${normalizeText(candidate.recordingMbid)}`;
  if (candidate.isrc?.trim()) return `isrc:${normalizeText(candidate.isrc)}`;
  return `track:${normalizeText(candidate.title)}|${normalizeText(candidate.artist)}`;
}

function stableCandidateKey(candidate: ExternalMusicCandidate): string {
  return `${candidate.provider}|${normalizeText(candidate.id)}|${normalizeText(candidate.artist)}|${normalizeText(candidate.title)}`;
}

function personalizationValue(candidate: ExternalMusicCandidate): number {
  const explicit = clamp01(candidate.personalizationScore);
  const liked = candidate.liked ? 0.25 : 0;
  const recent = Math.min(0.2, Math.log1p(Math.max(0, candidate.recentPlayCount ?? 0)) / 20);
  const originalRank = candidate.originalRank === undefined
    ? 0
    : Math.max(0, 1 - (Math.max(1, candidate.originalRank) - 1) / 19) * 0.35;
  return Math.min(1, explicit + liked + recent + originalRank);
}

function duplicatePreference(candidate: ExternalMusicCandidate): number {
  return (
    personalizationValue(candidate) * 100 +
    (candidate.liked ? 20 : 0) +
    Math.min(10, Math.log1p(Math.max(0, candidate.recentPlayCount ?? 0)) * 2) +
    clamp01(candidate.popularity) * 4 +
    (candidate.providerUrl ? 1 : 0)
  );
}

function prepareCandidates(
  options: RankExternalCandidatesOptions,
  candidates: readonly ExternalMusicCandidate[],
  currentMood: CanonicalMood,
  targetMood: CanonicalMood
): PreparedCandidate[] {
  const taste = options.tasteProfile ?? {};
  const avoidArtists = taste.avoidArtists ?? [];
  const avoidGenres = taste.avoidGenres ?? [];
  const excluded = new Set((options.excludedCandidateIds ?? []).map(normalizeText));
  const filtered = candidates
    .filter((candidate) => candidate.id?.trim() && candidate.title?.trim() && candidate.artist?.trim())
    .filter((candidate) => !excluded.has(normalizeText(candidate.id)))
    .map((candidate) => {
      const normalizedTags = (candidate.tags ?? []).map(normalizeText).filter(Boolean);
      const normalizedGenres = (candidate.genres ?? []).map(normalizeText).filter(Boolean);
      return { candidate, normalizedTags, normalizedGenres };
    })
    .filter(({ candidate, normalizedTags, normalizedGenres }) => (
      !matchesTerm(normalizeText(candidate.artist), avoidArtists) &&
      !genresMatch([...normalizedGenres, ...normalizedTags], avoidGenres)
    ))
    .filter(({ candidate, normalizedTags, normalizedGenres }) => {
      const instrumental = isInstrumental(candidate, [...normalizedTags, ...normalizedGenres]);
      if (taste.instrumentalOnly && !instrumental) return false;
      return languageMatches(candidate, taste.languagePreference, instrumental);
    })
    .sort((a, b) => {
      const keyDifference = duplicateKey(a.candidate).localeCompare(duplicateKey(b.candidate));
      if (keyDifference) return keyDifference;
      const preferenceDifference = duplicatePreference(b.candidate) - duplicatePreference(a.candidate);
      return preferenceDifference || stableCandidateKey(a.candidate).localeCompare(stableCandidateKey(b.candidate));
    });

  const unique = new Map<string, typeof filtered[number]>();
  for (const item of filtered) {
    const key = duplicateKey(item.candidate);
    if (!unique.has(key)) unique.set(key, item);
  }

  return [...unique.values()].map(({ candidate, normalizedTags, normalizedGenres }): PreparedCandidate => {
    const inferred = inferMood(candidate);
    const pathVector = MOOD_VECTORS[inferred.canonical];
    return {
      candidate,
      stableKey: stableCandidateKey(candidate),
      dedupeKey: duplicateKey(candidate),
      artistKey: normalizeText(candidate.artist),
      normalizedTags,
      normalizedGenres,
      effectiveDurationSec: candidate.durationSec && candidate.durationSec > 0
        ? Math.round(candidate.durationSec)
        : DEFAULT_DURATION_SEC,
      inferred,
      pathProgress: pathProjection(pathVector, currentMood, targetMood),
      targetDistance: vectorDistance(pathVector, MOOD_VECTORS[targetMood]),
      personalization: personalizationValue(candidate)
    };
  }).sort((a, b) => a.stableKey.localeCompare(b.stableKey));
}

function phaseCounts(total: number): Record<Phase, number> {
  if (total <= 0) return { mirror: 0, bridge: 0, arrive: 0 };
  if (total === 1) return { mirror: 0, bridge: 0, arrive: 1 };
  if (total === 2) return { mirror: 1, bridge: 0, arrive: 1 };

  const result: Record<Phase, number> = { mirror: 1, bridge: 1, arrive: 1 };
  while (result.mirror + result.bridge + result.arrive < total) {
    const phase = [...PHASES].sort((a, b) => {
      const deficitA = total * PHASE_TIME_WEIGHT[a] - result[a];
      const deficitB = total * PHASE_TIME_WEIGHT[b] - result[b];
      return deficitB - deficitA || PHASES.indexOf(a) - PHASES.indexOf(b);
    })[0] ?? "bridge";
    result[phase] += 1;
  }
  return result;
}

function buildSlots(total: number, currentMood: CanonicalMood, targetMood: CanonicalMood, minutes: number): PlannedSlot[] {
  const counts = phaseCounts(total);
  const allocations = allocatePhaseSeconds(minutes);
  const progressRanges: Record<Phase, readonly [number, number]> = {
    mirror: [0.04, 0.2],
    bridge: [0.34, 0.7],
    arrive: [0.8, 0.98]
  };
  return PHASES.flatMap((phase) => {
    const count = counts[phase];
    if (count === 0) return [];
    const [start, end] = progressRanges[phase];
    return Array.from({ length: count }, (_, index): PlannedSlot => {
      const progress = count === 1 ? PHASE_PROGRESS[phase] : start + (end - start) * index / (count - 1);
      return {
        phase,
        progress,
        targetVector: interpolateMood(currentMood, targetMood, progress),
        idealDurationSec: allocations[phase] / count
      };
    });
  });
}

function scoreCandidate(
  prepared: PreparedCandidate,
  slot: PlannedSlot,
  options: RankExternalCandidatesOptions,
  repeatedArtistCount: number,
  targetDistanceRegression: number
): number {
  const candidate = prepared.candidate;
  const taste = options.tasteProfile ?? {};
  const favoriteArtist = matchesTerm(prepared.artistKey, taste.favoriteArtists ?? []);
  const favoriteGenre = genresMatch([...prepared.normalizedGenres, ...prepared.normalizedTags], taste.favoriteGenres ?? []);
  const popularity = clamp01(candidate.popularity, 0.5);
  const familiarity = Math.min(1, prepared.personalization * 0.65 + popularity * 0.2 + (candidate.liked ? 0.15 : 0));
  const familiarityPreference = clamp01(taste.familiarVsDiscovery, 0.5);
  const moodDistance = vectorDistance(prepared.inferred.vector, slot.targetVector);
  const durationDifference = Math.abs(prepared.effectiveDurationSec - slot.idealDurationSec) / Math.max(1, slot.idealDurationSec);
  const contextualTerms = [...prepared.normalizedTags, ...prepared.normalizedGenres];
  const weatherMatch = options.weather
    ? contextualTerms.some((term) => matchesTerm(term, [options.weather ?? ""]))
    : false;
  const activityMatch = options.activity
    ? contextualTerms.some((term) => matchesTerm(term, [options.activity ?? ""]))
    : false;

  let score = 100 - moodDistance * 68;
  score += prepared.personalization * 42;
  if (candidate.liked) score += 15;
  score += Math.min(11, Math.log1p(Math.max(0, candidate.recentPlayCount ?? 0)) * 2.5);
  if (favoriteArtist) score += 20;
  if (favoriteGenre) score += 12;
  score += (familiarity - 0.5) * (familiarityPreference - 0.5) * 36;
  if (!prepared.inferred.hasMoodSignal) score += prepared.personalization * 12;
  if (weatherMatch) score += 4;
  if (activityMatch) score += 4;
  score -= repeatedArtistCount * 16;
  score -= durationDifference * 3;
  score -= targetDistanceRegression * 18;
  return score;
}

function stateSignature(state: SelectionState): string {
  return state.tracks.map((track) => track.stableKey).join("|");
}

function selectForSlots(
  pool: readonly PreparedCandidate[],
  slots: readonly PlannedSlot[],
  options: RankExternalCandidatesOptions,
  budgetSec: number
): SelectionState | undefined {
  let beams: SelectionState[] = [{
    tracks: [],
    elapsedSec: 0,
    score: 0,
    usedKeys: new Set<string>(),
    artistCounts: new Map<string, number>(),
    lastProgress: Number.NEGATIVE_INFINITY,
    lastTargetDistance: Number.POSITIVE_INFINITY
  }];

  for (const slot of slots) {
    const next: SelectionState[] = [];
    for (const state of beams) {
      for (const prepared of pool) {
        if (state.usedKeys.has(prepared.dedupeKey)) continue;
        if (state.elapsedSec + prepared.effectiveDurationSec > budgetSec) continue;
        if (prepared.pathProgress + 1e-9 < state.lastProgress) continue;

        const repeatedArtistCount = state.artistCounts.get(prepared.artistKey) ?? 0;
        const targetDistanceRegression = Number.isFinite(state.lastTargetDistance)
          ? Math.max(0, prepared.targetDistance - state.lastTargetDistance)
          : 0;
        const usedKeys = new Set(state.usedKeys);
        usedKeys.add(prepared.dedupeKey);
        const artistCounts = new Map(state.artistCounts);
        artistCounts.set(prepared.artistKey, repeatedArtistCount + 1);
        next.push({
          tracks: [...state.tracks, prepared],
          elapsedSec: state.elapsedSec + prepared.effectiveDurationSec,
          score: state.score + scoreCandidate(prepared, slot, options, repeatedArtistCount, targetDistanceRegression),
          usedKeys,
          artistCounts,
          lastProgress: prepared.pathProgress,
          lastTargetDistance: prepared.targetDistance
        });
      }
    }

    if (next.length === 0) return undefined;
    const unique = new Map<string, SelectionState>();
    next.sort((a, b) => b.score - a.score || b.elapsedSec - a.elapsedSec || stateSignature(a).localeCompare(stateSignature(b)));
    for (const state of next) {
      const signature = stateSignature(state);
      if (!unique.has(signature)) unique.set(signature, state);
      if (unique.size >= BEAM_WIDTH) break;
    }
    beams = [...unique.values()];
  }

  return beams.sort((a, b) => {
    const adjustedA = a.score - (budgetSec - a.elapsedSec) / 90;
    const adjustedB = b.score - (budgetSec - b.elapsedSec) / 90;
    return adjustedB - adjustedA || stateSignature(a).localeCompare(stateSignature(b));
  })[0];
}

function maximumTrackCount(pool: readonly PreparedCandidate[], budgetSec: number): number {
  const durations = pool.map((candidate) => candidate.effectiveDurationSec).sort((a, b) => a - b);
  let elapsed = 0;
  let count = 0;
  for (const duration of durations) {
    if (elapsed + duration > budgetSec || count >= MAX_TRACKS) break;
    elapsed += duration;
    count += 1;
  }
  return count;
}

function desiredTrackCount(pool: readonly PreparedCandidate[], budgetSec: number): number {
  const durations = pool.map((candidate) => candidate.effectiveDurationSec).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] ?? DEFAULT_DURATION_SEC;
  const maximum = maximumTrackCount(pool, budgetSec);
  const estimate = Math.max(1, Math.round(budgetSec / median));
  return Math.min(MAX_TRACKS, maximum, pool.length, Math.max(Math.min(3, maximum), estimate));
}

function makeLinks(candidate: ExternalMusicCandidate): LiveJourneyTrack["links"] {
  const clip = (value: string, maximum: number) => Array.from(value).slice(0, maximum).join("");
  const query = encodeURIComponent(`${clip(candidate.title, 40)} ${clip(candidate.artist, 24)}`.trim());
  return {
    youtubeMusicSearch: `https://music.youtube.com/search?q=${query}`,
    melonSearch: `https://www.melon.com/search/total/index.htm?q=${query}`
  };
}

function reasonFor(prepared: PreparedCandidate, phase: Phase, options: RankExternalCandidatesOptions): string {
  const evidence: string[] = [];
  if (prepared.candidate.liked) evidence.push("좋아요");
  if ((prepared.candidate.recentPlayCount ?? 0) > 0) evidence.push("최근 감상");
  if (matchesTerm(prepared.artistKey, options.tasteProfile?.favoriteArtists ?? [])) evidence.push("선호 아티스트");
  if (genresMatch([...prepared.normalizedGenres, ...prepared.normalizedTags], options.tasteProfile?.favoriteGenres ?? [])) evidence.push("선호 장르");
  if (!prepared.inferred.hasMoodSignal && prepared.personalization > 0) evidence.push("공급자 개인화(provider personalization)");
  const evidenceText = evidence.length > 0 ? ` 취향 근거: ${evidence.join(", ")}.` : "";
  const phaseText = phase === "mirror"
    ? "현재 기분을 먼저 인정하는 곡입니다."
    : phase === "bridge"
      ? "현재와 목표 사이를 부드럽게 잇는 곡입니다."
      : "목표 기분에 가까운 결로 도착하는 곡입니다.";
  return `${phaseText} 메타데이터에서 추론한 기분은 ${prepared.inferred.canonical}입니다.${evidenceText}`;
}

function journeyId(options: RankExternalCandidatesOptions, tracks: readonly PreparedCandidate[]): string {
  const payload = JSON.stringify({
    currentMood: options.currentMood,
    targetMood: options.targetMood,
    minutes: options.minutes,
    weather: options.weather,
    activity: options.activity,
    tasteProfile: options.tasteProfile,
    tracks: tracks.map((track) => track.stableKey)
  });
  return `live-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

export function rankExternalCandidates(
  options: RankExternalCandidatesOptions,
  candidates: readonly ExternalMusicCandidate[]
): LiveJourney {
  assertMinutes(options.minutes);
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(`candidates must contain at most ${MAX_CANDIDATES} tracks`);
  }

  const currentMood = normalizeMood(options.currentMood);
  const targetMood = normalizeMood(options.targetMood);
  const budgetSec = Math.round(options.minutes * 60);
  const pool = prepareCandidates(options, candidates, currentMood, targetMood);
  if (pool.length < 3) {
    throw new Error("At least three usable candidates are required after exclusions and preference filters");
  }
  const desired = desiredTrackCount(pool, budgetSec);
  let selected: SelectionState | undefined;
  let selectedSlots: PlannedSlot[] = [];

  for (let count = desired; count >= 1; count -= 1) {
    const slots = buildSlots(count, currentMood, targetMood, options.minutes);
    const result = selectForSlots(pool, slots, options, budgetSec);
    if (result) {
      selected = result;
      selectedSlots = slots;
      break;
    }
  }

  if (!selected || selected.tracks.length < 3) {
    throw new Error("The candidate pool cannot fill all three stages within the requested time");
  }
  const preparedTracks = selected.tracks;
  const tracks = preparedTracks.map((prepared, index): LiveJourneyTrack => {
    const slot = selectedSlots[index] ?? {
      phase: "arrive",
      progress: 1,
      targetVector: MOOD_VECTORS[targetMood],
      idealDurationSec: prepared.effectiveDurationSec
    };
    return {
      ...prepared.candidate,
      phase: slot.phase,
      position: index + 1,
      reason: reasonFor(prepared, slot.phase, options),
      score: round(scoreCandidate(prepared, slot, options, 0, 0), 3),
      inferredMood: prepared.inferred.canonical,
      links: makeLinks(prepared.candidate)
    };
  });
  const elapsedSec = selected?.elapsedSec ?? 0;

  return {
    journeyId: journeyId(options, preparedTracks),
    currentMood,
    targetMood,
    requestedMinutes: options.minutes,
    estimatedMinutes: round(elapsedSec / 60, 2),
    candidateSource: options.candidateSource ?? "external-candidates",
    context: {
      ...(options.weather?.trim() ? { weather: options.weather.trim() } : {}),
      ...(options.activity?.trim() ? { activity: options.activity.trim() } : {}),
      sourceNote: `Ranked ${pool.length} unique tracks supplied by external providers. Missing durations use a ${DEFAULT_DURATION_SEC}-second planning estimate.`
    },
    tracks
  };
}
