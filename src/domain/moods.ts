import type { ActivityTag, CanonicalMood, MoodVector, WeatherTag } from "./types.js";

export const MOOD_VECTORS: Record<CanonicalMood, MoodVector> = {
  calm: { valence: 0.58, energy: 0.22, acousticness: 0.78 },
  content: { valence: 0.68, energy: 0.42, acousticness: 0.55 },
  sad: { valence: 0.18, energy: 0.25, acousticness: 0.72 },
  anxious: { valence: 0.28, energy: 0.68, acousticness: 0.38 },
  tired: { valence: 0.38, energy: 0.14, acousticness: 0.72 },
  focused: { valence: 0.52, energy: 0.46, acousticness: 0.62 },
  hopeful: { valence: 0.73, energy: 0.55, acousticness: 0.54 },
  joyful: { valence: 0.88, energy: 0.72, acousticness: 0.28 },
  energetic: { valence: 0.78, energy: 0.92, acousticness: 0.12 },
  angry: { valence: 0.18, energy: 0.9, acousticness: 0.12 },
  lonely: { valence: 0.2, energy: 0.18, acousticness: 0.8 },
  romantic: { valence: 0.66, energy: 0.35, acousticness: 0.66 }
};

export const MOOD_KOREAN_LABELS: Record<CanonicalMood, string> = {
  calm: "차분",
  content: "편안",
  sad: "울적",
  anxious: "불안",
  tired: "지침",
  focused: "집중",
  hopeful: "희망",
  joyful: "기쁨",
  energetic: "활력",
  angry: "분노",
  lonely: "외로움",
  romantic: "설렘"
};

const SYNONYMS: Record<string, CanonicalMood> = {
  calm: "calm", peaceful: "calm", relaxed: "calm", serene: "calm", 편안: "calm", 편안함: "calm", 차분: "calm", 차분함: "calm", 평온: "calm", 안정: "calm",
  content: "content", okay: "content", neutral: "content", satisfied: "content", 무난: "content", 괜찮: "content", 만족: "content", 보통: "content",
  sad: "sad", down: "sad", gloomy: "sad", blue: "sad", 슬픔: "sad", 슬퍼: "sad", 우울: "sad", 울적: "sad", 침울: "sad", 가라앉음: "sad", 가라앉: "sad", 안좋: "sad", 별로: "sad",
  anxious: "anxious", nervous: "anxious", stressed: "anxious", tense: "anxious", 불안: "anxious", 초조: "anxious", 긴장: "anxious", 스트레스: "anxious",
  tired: "tired", sleepy: "tired", exhausted: "tired", drained: "tired", 피곤: "tired", 지침: "tired", 졸림: "tired", 무기력: "tired",
  focused: "focused", focus: "focused", productive: "focused", concentrating: "focused", 집중: "focused", 몰입: "focused", 생산적: "focused",
  hopeful: "hopeful", optimistic: "hopeful", encouraged: "hopeful", hopefuls: "hopeful", 희망: "hopeful", 기대: "hopeful", 용기: "hopeful", 위로: "hopeful", 기분전환: "hopeful",
  joyful: "joyful", happy: "joyful", cheerful: "joyful", delighted: "joyful", 행복: "joyful", 기쁨: "joyful", 신남: "joyful", 신나: "joyful", 즐거움: "joyful", 밝음: "joyful", 밝은: "joyful", 밝게: "joyful", 밝아: "joyful", 좋음: "joyful", 좋아: "joyful", 좋은: "joyful", 좋게: "joyful",
  energetic: "energetic", pumped: "energetic", excited: "energetic", motivated: "energetic", 활기: "energetic", 에너지: "energetic", 의욕: "energetic", 들뜸: "energetic",
  angry: "angry", mad: "angry", furious: "angry", frustrated: "angry", 화남: "angry", 분노: "angry", 짜증: "angry", 답답: "angry",
  lonely: "lonely", isolated: "lonely", alone: "lonely", 외로움: "lonely", 외로운: "lonely", 쓸쓸: "lonely",
  romantic: "romantic", loving: "romantic", affectionate: "romantic", 설렘: "romantic", 사랑: "romantic", 로맨틱: "romantic"
};

interface DescriptorRule {
  pattern: RegExp;
  mood: CanonicalMood;
  tags: readonly string[];
}

const DESCRIPTOR_RULES: readonly DescriptorRule[] = [
  {
    pattern: /시원|청량|상쾌|개운|산뜻|refresh|fresh|breez|crisp|cool/iu,
    mood: "energetic",
    tags: ["refreshing", "upbeat", "summer", "dance pop"]
  },
  {
    pattern: /더운|더워|덥|무더|폭염|후덥|습하|hot|heat|humid|muggy/iu,
    mood: "content",
    tags: ["summer", "tropical", "chillout"]
  },
  {
    pattern: /포근|따뜻|아늑|cozy|warm/iu,
    mood: "calm",
    tags: ["cozy", "acoustic", "soft"]
  },
  {
    pattern: /몽환|신비|dreamy|dreamlike|ethereal/iu,
    mood: "calm",
    tags: ["dreamy", "dream pop", "ambient"]
  },
  {
    pattern: /감성|센치|nostal|추억|향수/iu,
    mood: "romantic",
    tags: ["nostalgic", "indie pop", "acoustic"]
  },
  {
    pattern: /강렬|웅장|짜릿|통쾌|폭발|intense|powerful|epic|groovy/iu,
    mood: "energetic",
    tags: ["energetic", "power", "upbeat"]
  },
  {
    pattern: /어두|dark|moody|somber/iu,
    mood: "sad",
    tags: ["moody", "melancholic", "indie"]
  }
] as const;

export interface MoodInterpretation {
  mood: CanonicalMood;
  kind: "mood" | "descriptor" | "default";
  contextTags: string[];
  vector?: MoodVector;
}

function compact(value: string): string {
  return value.trim().toLocaleLowerCase("en").replace(/[\s_-]+/g, "");
}

function isNegatedAt(value: string, index: number, length: number): boolean {
  const before = value.slice(Math.max(0, index - 12), index);
  const after = value.slice(index + length, index + length + 16);
  return /(?:안|덜|not|no|without|avoid)$/iu.test(before)
    || /^(?:하지(?:는)?않|지(?:는)?않|하지말|한건아니|한게아니|은아니|는아니|아니|말고|빼고|제외|싫)/iu.test(after);
}

function includesUnnegated(value: string, term: string): boolean {
  let from = 0;
  while (from <= value.length - term.length) {
    const index = value.indexOf(term, from);
    if (index < 0) return false;
    if (!isNegatedAt(value, index, term.length)) return true;
    from = index + Math.max(1, term.length);
  }
  return false;
}

function matchesUnnegated(value: string, pattern: RegExp): boolean {
  const flags = [...new Set(`${pattern.flags}g`.split(""))].join("");
  const matcher = new RegExp(pattern.source, flags);
  for (const match of value.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (!isNegatedAt(value, index, match[0].length)) return true;
  }
  return false;
}

function nearestMood(vector: MoodVector): CanonicalMood {
  return (Object.entries(MOOD_VECTORS) as Array<[CanonicalMood, MoodVector]>)
    .sort(([, left], [, right]) => {
      const distance = (candidate: MoodVector) => (
        (candidate.valence - vector.valence) ** 2
        + (candidate.energy - vector.energy) ** 2
        + (candidate.acousticness - vector.acousticness) ** 2
      );
      return distance(left) - distance(right);
    })[0]?.[0] ?? "content";
}

export function normalizeMood(value: string): CanonicalMood {
  const normalized = compact(value);
  const exact = SYNONYMS[normalized];
  if (exact) return exact;

  const ordered = Object.entries(SYNONYMS).sort(([a], [b]) => b.length - a.length);
  const contained = ordered.find(([key]) => includesUnnegated(normalized, key));
  if (contained) return contained[1];
  throw new Error(`지원하지 않는 기분 표현입니다: ${value.trim()}`);
}

/**
 * MCP callers sometimes place weather or sensory vibe wording in a mood field.
 * Keep normalizeMood strict for domain validation, but make the public boundary
 * tolerant and preserve those descriptors as music-discovery tags.
 */
export function interpretMood(value: string | undefined, fallback: CanonicalMood): MoodInterpretation {
  if (!value?.trim()) return { mood: fallback, kind: "default", contextTags: [] };
  const normalized = compact(value);
  let canonical: CanonicalMood | undefined;
  try {
    canonical = normalizeMood(value);
  } catch {
    canonical = undefined;
  }
  const descriptorRules = DESCRIPTOR_RULES.filter(({ pattern }) => matchesUnnegated(normalized, pattern));
  if (descriptorRules.length > 0) {
    const moods = [...(canonical ? [canonical] : []), ...descriptorRules.map((rule) => rule.mood)];
    const vector = moods.reduce<MoodVector>((result, mood) => ({
      valence: result.valence + MOOD_VECTORS[mood].valence / moods.length,
      energy: result.energy + MOOD_VECTORS[mood].energy / moods.length,
      acousticness: result.acousticness + MOOD_VECTORS[mood].acousticness / moods.length
    }), { valence: 0, energy: 0, acousticness: 0 });
    return {
      mood: nearestMood(vector),
      kind: "descriptor",
      contextTags: [...new Set(descriptorRules.flatMap((rule) => rule.tags))].slice(0, 12),
      vector
    };
  }
  if (canonical) return { mood: canonical, kind: "mood", contextTags: [] };

  return {
    mood: fallback,
    kind: "default",
    contextTags: []
  };
}

const WEATHER_MUSIC_TAGS: Record<WeatherTag, readonly string[]> = {
  clear: ["sunny", "feel good", "indie pop"],
  cloudy: ["dreamy", "indie", "ambient"],
  rain: ["rainy day", "acoustic", "lo-fi"],
  snow: ["winter", "piano", "acoustic"],
  hot: ["summer", "tropical", "chillout"],
  cold: ["winter", "cozy", "acoustic"],
  wind: ["breezy", "dream pop", "indie pop"],
  unknown: []
};

export function musicContextTags(weather?: string, desiredVibe?: string): string[] {
  const vibe = interpretMood(desiredVibe, "content");
  return [...new Set([
    ...WEATHER_MUSIC_TAGS[normalizeWeather(weather)],
    ...vibe.contextTags
  ])].slice(0, 8);
}

export function interpolateMood(from: CanonicalMood, to: CanonicalMood, progress: number): MoodVector {
  const a = MOOD_VECTORS[from];
  const b = MOOD_VECTORS[to];
  const p = Math.max(0, Math.min(1, progress));
  return {
    valence: a.valence + (b.valence - a.valence) * p,
    energy: a.energy + (b.energy - a.energy) * p,
    acousticness: a.acousticness + (b.acousticness - a.acousticness) * p
  };
}

export function normalizeWeather(value?: string): WeatherTag {
  if (!value) return "unknown";
  const normalized = compact(value);
  if (matchesUnnegated(normalized, /hail|snow|sleet|우박|눈(?:이|은|오는|와|옴|내리|중|$)|눈보라|진눈깨비/u)) return "snow";
  if (matchesUnnegated(normalized, /storm|thunder|lightning|typhoon|rain|drizzle|shower|폭풍|태풍|천둥|번개|비(?:가|는|오는|와|옴|내리|중|$)|빗|소나기|장마/u)) return "rain";
  if (matchesUnnegated(normalized, /fog|mist|cloud|overcast|안개|흐림|흐린|흐려|구름/u)) return "cloudy";
  if (matchesUnnegated(normalized, /wind|breeze|cool|바람|바람부|선선|시원/u)) return "wind";
  if (matchesUnnegated(normalized, /hot|heat|humid|muggy|더움|더운|더워|덥|무더|폭염|후덥|습하/u)) return "hot";
  if (matchesUnnegated(normalized, /cold|chilly|추움|추운|추워|춥|한파/u)) return "cold";
  if (matchesUnnegated(normalized, /clear|sun|sunny|맑음|맑은|맑아|맑고|화창/u)) return "clear";
  return "unknown";
}

export function normalizeActivity(value?: string): ActivityTag | undefined {
  if (!value) return undefined;
  const normalized = compact(value);
  if (matchesUnnegated(normalized, /sleep|bed|잠|수면/u)) return "sleep";
  if (matchesUnnegated(normalized, /study|read|공부|독서/u)) return "study";
  if (matchesUnnegated(normalized, /work|office|업무|작업|일하/u)) return "work";
  if (matchesUnnegated(normalized, /run|gym|exercise|workout|운동|러닝|헬스/u)) return "exercise";
  if (matchesUnnegated(normalized, /commute|drive|bus|subway|출근|퇴근|운전|드라이브|지하철/u)) return "commute";
  if (matchesUnnegated(normalized, /walk|stroll|산책/u)) return "walk";
  return "rest";
}
