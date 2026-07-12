import { createHash } from "node:crypto";
import { TRACK_CATALOG } from "./catalog.js";
import { interpolateMood, MOOD_KOREAN_LABELS, MOOD_VECTORS, normalizeActivity, normalizeMood, normalizeWeather } from "./moods.js";
import { CANONICAL_MOODS } from "./types.js";
import type { CanonicalMood, Journey, JourneyContext, JourneyOptions, JourneyTrack, MoodVector, Phase, Track } from "./types.js";

export const PHASES: readonly Phase[] = ["mirror", "bridge", "arrive"];

export const PHASE_META: Record<Phase, { label: string; koreanLabel: string; progress: number }> = {
  mirror: { label: "Mirror", koreanLabel: "지금 비추기", progress: 0.08 },
  bridge: { label: "Bridge", koreanLabel: "부드럽게 건너기", progress: 0.52 },
  arrive: { label: "Arrive", koreanLabel: "원하는 기분에 닿기", progress: 0.94 }
};

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
}

function isAvoided(track: Track, avoidArtists: readonly string[]): boolean {
  const artist = normalizeText(track.artist);
  return avoidArtists.some((avoid) => {
    const term = normalizeText(avoid);
    return term.length > 0 && (artist === term || artist.includes(term));
  });
}

function distance(track: Track, target: MoodVector): number {
  return (
    Math.abs(track.valence - target.valence) * 0.42 +
    Math.abs(track.energy - target.energy) * 0.42 +
    Math.abs(track.acousticness - target.acousticness) * 0.16
  );
}

function scoreTrack(
  track: Track,
  phase: Phase,
  currentMood: CanonicalMood,
  targetMood: CanonicalMood,
  targetVector: MoodVector,
  weather: ReturnType<typeof normalizeWeather>,
  activity: ReturnType<typeof normalizeActivity>,
  familiarityBias: number,
  usedArtists: ReadonlySet<string>,
  idealDuration: number,
  intendedProgress: number,
  actualProgress: number
): number {
  let score = distance(track, targetVector) * 100;
  const anchorMood = phase === "mirror" ? currentMood : phase === "arrive" ? targetMood : undefined;
  if (anchorMood && track.moods.includes(anchorMood)) score -= 11;
  if (weather !== "unknown" && track.weather.includes(weather)) score -= 5;
  if (activity && track.activities.includes(activity)) score -= 5;
  score -= familiarityBias * (track.familiarity - 0.5) * 18;
  if (usedArtists.has(normalizeText(track.artist))) score += 13;
  score += Math.abs(track.durationSec - idealDuration) / Math.max(idealDuration, 1) * 4;
  score += Math.abs(actualProgress - intendedProgress) * 36;
  if (actualProgress < -0.15) score += (-0.15 - actualProgress) * 80;
  if (actualProgress > 1.15) score += (actualProgress - 1.15) * 80;
  return score;
}

function makeLinks(track: Track): JourneyTrack["links"] {
  const query = encodeURIComponent(`${track.title} ${track.artist}`);
  const isKorean = track.locale === "ko";
  return {
    youtubeMusic: `https://music.youtube.com/search?q=${query}`,
    secondary: isKorean
      ? `https://www.melon.com/search/total/index.htm?q=${query}`
      : `https://open.spotify.com/search/${query}`,
    secondaryLabel: isKorean ? "Melon" : "Spotify"
  };
}

function reasonFor(track: Track, phase: Phase, currentMood: CanonicalMood, targetMood: CanonicalMood, hasContextMatch: boolean): string {
  const currentLabel = MOOD_KOREAN_LABELS[currentMood];
  const targetLabel = MOOD_KOREAN_LABELS[targetMood];
  const context = hasContextMatch ? " 지금의 날씨나 활동에도 자연스럽게 어울립니다." : " 곡의 결이 다음 단계와 부드럽게 이어집니다.";
  if (phase === "mirror") return `${currentLabel}의 에너지와 정서를 먼저 인정하는 곡입니다.${context}`;
  if (phase === "bridge") return `${currentLabel}에서 ${targetLabel} 방향으로 급하지 않게 전환하는 연결점입니다.${context}`;
  return `${targetLabel}에 가까운 에너지와 밝기로 여정을 마무리하는 곡입니다.${context}`;
}

function computeMaxTrackCount(candidates: readonly Track[], budgetSec: number): number {
  const durations = candidates.map((track) => track.durationSec).sort((a, b) => a - b);
  let sum = 0;
  let count = 0;
  for (const duration of durations) {
    if (sum + duration > budgetSec) break;
    sum += duration;
    count += 1;
  }
  return count;
}

function splitCount(total: number): Record<Phase, number> {
  const result: Record<Phase, number> = { mirror: 1, bridge: 1, arrive: 1 };
  const weights: readonly Phase[] = ["bridge", "arrive", "mirror"];
  for (let index = 3; index < total; index += 1) {
    const phase = weights[(index - 3) % weights.length] ?? "bridge";
    result[phase] += 1;
  }
  return result;
}

interface PlannedSlot {
  phase: Phase;
  progress: number;
}

interface SelectionState {
  tracks: Track[];
  elapsedSec: number;
  score: number;
  usedArtists: Set<string>;
  phaseSum: MoodVector;
  phaseCount: number;
  lastPhaseDistance?: number;
}

const PHASE_PROGRESS_RANGE: Record<Phase, readonly [number, number]> = {
  mirror: [0.04, 0.22],
  bridge: [0.32, 0.70],
  arrive: [0.78, 0.98]
};

function planSlots(phaseCounts: Record<Phase, number>): PlannedSlot[] {
  return PHASES.flatMap((phase) => {
    const count = phaseCounts[phase];
    const [start, end] = PHASE_PROGRESS_RANGE[phase];
    return Array.from({ length: count }, (_, index) => ({
      phase,
      progress: count === 1 ? PHASE_META[phase].progress : start + (end - start) * index / (count - 1)
    }));
  });
}

function pathProjection(track: Track, from: MoodVector, to: MoodVector): number {
  const delta = {
    valence: to.valence - from.valence,
    energy: to.energy - from.energy,
    acousticness: to.acousticness - from.acousticness
  };
  const denominator = delta.valence ** 2 + delta.energy ** 2 + delta.acousticness ** 2;
  if (denominator < Number.EPSILON) return 0;
  return (
    (track.valence - from.valence) * delta.valence +
    (track.energy - from.energy) * delta.energy +
    (track.acousticness - from.acousticness) * delta.acousticness
  ) / denominator;
}

function vectorDistance(from: MoodVector, to: MoodVector): number {
  return Math.sqrt(
    (from.valence - to.valence) ** 2 +
    (from.energy - to.energy) ** 2 +
    (from.acousticness - to.acousticness) ** 2
  );
}

function suffixMinimumDurations(candidates: readonly Track[], maximumSlots: number): number[][] {
  const result = Array.from({ length: candidates.length + 1 }, () => Array<number>(maximumSlots + 1).fill(Number.POSITIVE_INFINITY));
  result[candidates.length]![0] = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    result[index]![0] = 0;
    for (let slots = 1; slots <= maximumSlots; slots += 1) {
      result[index]![slots] = Math.min(
        result[index + 1]![slots] ?? Number.POSITIVE_INFINITY,
        candidates[index]!.durationSec + (result[index + 1]![slots - 1] ?? Number.POSITIVE_INFINITY)
      );
    }
  }
  return result;
}

function stateSignature(state: SelectionState): string {
  return state.tracks.map((track) => track.id).join("|");
}

function selectProgressiveTracks(
  candidates: readonly Track[],
  slots: readonly PlannedSlot[],
  currentMood: CanonicalMood,
  targetMood: CanonicalMood,
  weather: ReturnType<typeof normalizeWeather>,
  activity: ReturnType<typeof normalizeActivity>,
  familiarityBias: number,
  budgetSec: number,
  enforceCentroidProgress = true
): Track[] {
  const fromVector = MOOD_VECTORS[currentMood];
  const toVector = MOOD_VECTORS[targetMood];
  const sameMood = currentMood === targetMood;
  const ordered = [...candidates].sort((a, b) => {
    if (sameMood) return distance(b, toVector) - distance(a, toVector) || a.id.localeCompare(b.id);
    return pathProjection(a, fromVector, toVector) - pathProjection(b, fromVector, toVector) || a.id.localeCompare(b.id);
  });
  const suffixMinimum = suffixMinimumDurations(ordered, slots.length);
  const idealDuration = budgetSec / slots.length;
  const beamWidth = 96;
  let beams: SelectionState[][] = Array.from({ length: slots.length + 1 }, () => []);
  beams[0] = [{
    tracks: [],
    elapsedSec: 0,
    score: 0,
    usedArtists: new Set<string>(),
    phaseSum: { valence: 0, energy: 0, acousticness: 0 },
    phaseCount: 0
  }];

  for (let candidateIndex = 0; candidateIndex < ordered.length; candidateIndex += 1) {
    const track = ordered[candidateIndex]!;
    const next = beams.map((states) => [...states]);
    for (let selectedCount = 0; selectedCount < slots.length; selectedCount += 1) {
      const slot = slots[selectedCount]!;
      for (const state of beams[selectedCount]!) {
        const elapsedSec = state.elapsedSec + track.durationSec;
        const remainingSlots = slots.length - selectedCount - 1;
        const futureMinimum = suffixMinimum[candidateIndex + 1]![remainingSlots] ?? Number.POSITIVE_INFINITY;
        if (elapsedSec + futureMinimum > budgetSec) continue;

        const usedArtists = new Set(state.usedArtists);
        usedArtists.add(normalizeText(track.artist));
        const targetVector = interpolateMood(currentMood, targetMood, slot.progress);
        const actualProgress = sameMood ? slot.progress : pathProjection(track, fromVector, toVector);
        const phaseSum = {
          valence: state.phaseSum.valence + track.valence,
          energy: state.phaseSum.energy + track.energy,
          acousticness: state.phaseSum.acousticness + track.acousticness
        };
        const phaseCount = state.phaseCount + 1;
        const phaseEnds = slots[selectedCount + 1]?.phase !== slot.phase;
        let lastPhaseDistance = state.lastPhaseDistance;
        if (phaseEnds) {
          const centroid = {
            valence: phaseSum.valence / phaseCount,
            energy: phaseSum.energy / phaseCount,
            acousticness: phaseSum.acousticness / phaseCount
          };
          const completedDistance = vectorDistance(centroid, toVector);
          if (enforceCentroidProgress && lastPhaseDistance !== undefined && completedDistance > lastPhaseDistance + 1e-9) continue;
          lastPhaseDistance = completedDistance;
        }
        next[selectedCount + 1]!.push({
          tracks: [...state.tracks, track],
          elapsedSec,
          score: state.score + scoreTrack(
            track,
            slot.phase,
            currentMood,
            targetMood,
            targetVector,
            weather,
            activity,
            familiarityBias,
            state.usedArtists,
            idealDuration,
            slot.progress,
            actualProgress
          ),
          usedArtists,
          phaseSum: phaseEnds ? { valence: 0, energy: 0, acousticness: 0 } : phaseSum,
          phaseCount: phaseEnds ? 0 : phaseCount,
          ...(lastPhaseDistance === undefined ? {} : { lastPhaseDistance })
        });
      }
    }

    for (let count = 0; count <= slots.length; count += 1) {
      next[count]!.sort((a, b) => a.score - b.score || a.elapsedSec - b.elapsedSec || stateSignature(a).localeCompare(stateSignature(b)));
      if (next[count]!.length > beamWidth) next[count] = next[count]!.slice(0, beamWidth);
    }
    beams = next;
  }

  const completed = beams[slots.length]!;
  completed.sort((a, b) => {
    const aScore = a.score + (budgetSec - a.elapsedSec) / budgetSec * 10;
    const bScore = b.score + (budgetSec - b.elapsedSec) / budgetSec * 10;
    return aScore - bScore || stateSignature(a).localeCompare(stateSignature(b));
  });
  const selected = completed[0]?.tracks;
  if (!selected && enforceCentroidProgress) {
    return selectProgressiveTracks(candidates, slots, currentMood, targetMood, weather, activity, familiarityBias, budgetSec, false);
  }
  if (!selected) throw new Error("요청 시간과 조건을 함께 만족하는 3단계 여정을 구성할 수 없습니다.");
  return selected;
}

function stableJourneyId(options: JourneyOptions, ids: readonly string[]): string {
  const material = JSON.stringify({
    currentMood: normalizeMood(options.currentMood),
    targetMood: normalizeMood(options.targetMood),
    weather: options.weather ? normalizeText(options.weather) : "",
    activity: options.activity ? normalizeText(options.activity) : "",
    minutes: options.minutes,
    languagePreference: options.languagePreference ?? "any",
    instrumentalOnly: options.instrumentalOnly ?? false,
    avoidArtists: (options.avoidArtists ?? []).map(normalizeText).sort(),
    ids
  });
  return `mt_${createHash("sha256").update(material).digest("hex").slice(0, 12)}`;
}

function chooseCandidates(options: JourneyOptions, catalog: readonly Track[]): Track[] {
  const avoidArtists = options.avoidArtists ?? [];
  const excluded = new Set(options.excludedTrackIds ?? []);
  let candidates = catalog.filter((track) => !excluded.has(track.id) && !isAvoided(track, avoidArtists));

  if (options.instrumentalOnly || options.languagePreference === "instrumental") {
    candidates = candidates.filter((track) => track.instrumental);
  } else if (options.languagePreference === "korean") {
    candidates = candidates.filter((track) => track.locale === "ko");
  } else if (options.languagePreference === "international") {
    candidates = candidates.filter((track) => track.locale === "international");
  }

  if (candidates.length < 3) {
    throw new Error("선택 조건에 맞는 곡이 3개 미만입니다. 제외 아티스트 또는 언어 조건을 줄여 주세요.");
  }
  return candidates;
}

export function buildJourney(options: JourneyOptions, catalog: readonly Track[] = TRACK_CATALOG): Journey {
  if (!Number.isInteger(options.minutes) || options.minutes < 10 || options.minutes > 60) {
    throw new Error("minutes는 10~60 사이의 정수여야 합니다.");
  }

  const currentMood = normalizeMood(options.currentMood);
  const targetMood = normalizeMood(options.targetMood);
  const weather = normalizeWeather(options.weather);
  const activity = normalizeActivity(options.activity);
  const candidates = chooseCandidates(options, catalog);
  const budgetSec = options.minutes * 60;
  const desiredCount = Math.max(3, Math.min(18, Math.floor(budgetSec / 205)));
  const maximumCount = computeMaxTrackCount(candidates, budgetSec);
  const trackCount = Math.min(desiredCount, maximumCount);
  if (trackCount < 3) {
    throw new Error("요청 시간 안에 3단계 여정을 구성할 수 없습니다. 시간을 늘려 주세요.");
  }

  const phaseCounts = splitCount(trackCount);
  const slots = planSlots(phaseCounts);
  const weatherSource = options.weatherSource ?? (options.weather ? "provided" : undefined);
  const familiarityBias = Math.max(-1, Math.min(1, options.familiarityBias ?? 0));
  const plannedTracks = selectProgressiveTracks(candidates, slots, currentMood, targetMood, weather, activity, familiarityBias, budgetSec);
  const selected: JourneyTrack[] = plannedTracks.map((chosen, index) => {
    const phase = slots[index]!.phase;
    const hasContextMatch = (weather !== "unknown" && chosen.weather.includes(weather)) || Boolean(activity && chosen.activities.includes(activity));
    return {
      ...chosen,
      phase,
      position: index + 1,
      reason: reasonFor(chosen, phase, currentMood, targetMood, hasContextMatch),
      links: makeLinks(chosen)
    };
  });
  const elapsedSec = plannedTracks.reduce((sum, track) => sum + track.durationSec, 0);

  const journeyId = stableJourneyId(options, selected.map((track) => track.id));
  return {
    journeyId,
    currentMood,
    targetMood,
    requestedMinutes: options.minutes,
    estimatedMinutes: Math.round(elapsedSec / 6) / 10,
    context: {
      ...(options.weather ? { weather: options.weather } : {}),
      ...(options.activity ? { activity: options.activity } : {}),
      ...(weatherSource ? { weatherSource } : {}),
      ...(options.languagePreference ? { languagePreference: options.languagePreference } : {}),
      ...(options.instrumentalOnly === undefined ? {} : { instrumentalOnly: options.instrumentalOnly })
    },
    tracks: selected
  };
}

export type RefineFeedback = "calmer" | "brighter" | "more_energy" | "less_energy" | "more_familiar" | "more_discovery";

export interface RefineJourneyInput {
  previousTrackIds: string[];
  previousCurrentMood: string;
  previousTargetMood: string;
  previousRequestedMinutes: number;
  previousContext?: JourneyContext;
  feedback: RefineFeedback;
  targetMood?: string;
  avoidArtists?: string[];
}

function adjustedTargetMood(previousTarget: CanonicalMood, feedback: RefineFeedback): CanonicalMood {
  if (feedback === "more_familiar" || feedback === "more_discovery") return previousTarget;
  const base = MOOD_VECTORS[previousTarget];
  const desired: MoodVector = { ...base };
  if (feedback === "brighter") desired.valence = Math.min(1, desired.valence + 0.25);
  if (feedback === "more_energy") desired.energy = Math.min(1, desired.energy + 0.25);
  if (feedback === "less_energy") desired.energy = Math.max(0, desired.energy - 0.25);
  if (feedback === "calmer") {
    desired.energy = Math.max(0, desired.energy - 0.22);
    desired.acousticness = Math.min(1, desired.acousticness + 0.18);
  }

  const movesInRequestedDirection = (mood: CanonicalMood): boolean => {
    const candidate = MOOD_VECTORS[mood];
    if (feedback === "brighter") return candidate.valence > base.valence;
    if (feedback === "more_energy") return candidate.energy > base.energy;
    if (feedback === "less_energy") return candidate.energy < base.energy;
    return candidate.energy < base.energy || candidate.acousticness > base.acousticness;
  };
  const candidates = CANONICAL_MOODS.filter(movesInRequestedDirection);
  if (candidates.length === 0) return previousTarget;
  return [...candidates].sort((a, b) => {
    const vectorDistance = (mood: CanonicalMood): number => {
      const vector = MOOD_VECTORS[mood];
      return Math.abs(vector.valence - desired.valence) + Math.abs(vector.energy - desired.energy) + Math.abs(vector.acousticness - desired.acousticness);
    };
    return vectorDistance(a) - vectorDistance(b) || a.localeCompare(b);
  })[0]!;
}

export function refineJourney(input: RefineJourneyInput): Journey {
  const currentMood = normalizeMood(input.previousCurrentMood);
  const previousTargetMood = normalizeMood(input.previousTargetMood);
  const targetMood = input.targetMood ? normalizeMood(input.targetMood) : adjustedTargetMood(previousTargetMood, input.feedback);
  const familiarityBias = input.feedback === "more_familiar" ? 1 : input.feedback === "more_discovery" ? -1 : 0;
  const context = input.previousContext;

  return buildJourney({
    currentMood,
    targetMood,
    minutes: input.previousRequestedMinutes,
    ...(context?.weather === undefined ? {} : { weather: context.weather }),
    ...(context?.activity === undefined ? {} : { activity: context.activity }),
    ...(context?.weatherSource === undefined ? {} : { weatherSource: context.weatherSource }),
    ...(context?.languagePreference === undefined ? {} : { languagePreference: context.languagePreference }),
    ...(context?.instrumentalOnly === undefined ? {} : { instrumentalOnly: context.instrumentalOnly }),
    avoidArtists: input.avoidArtists,
    excludedTrackIds: [...new Set(input.previousTrackIds)],
    familiarityBias
  });
}
