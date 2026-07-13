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
}

function compact(value: string): string {
  return value.trim().toLocaleLowerCase("en").replace(/[\s_-]+/g, "");
}

export function normalizeMood(value: string): CanonicalMood {
  const normalized = compact(value);
  const exact = SYNONYMS[normalized];
  if (exact) return exact;

  const ordered = Object.entries(SYNONYMS).sort(([a], [b]) => b.length - a.length);
  const contained = ordered.find(([key]) => normalized.includes(key));
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
  try {
    return { mood: normalizeMood(value), kind: "mood", contextTags: [] };
  } catch {
    const normalized = compact(value);
    const rule = DESCRIPTOR_RULES.find(({ pattern }) => pattern.test(normalized));
    if (rule) return { mood: rule.mood, kind: "descriptor", contextTags: [...rule.tags] };

    const safeTag = value
      .normalize("NFKC")
      .trim()
      .toLocaleLowerCase("en")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64);
    return {
      mood: fallback,
      kind: "default",
      contextTags: safeTag ? [safeTag] : []
    };
  }
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
  if (/hail|snow|sleet|우박|눈(?:이|은|오는|와|옴|내리|중|$)|눈보라|진눈깨비/.test(normalized)) return "snow";
  if (/storm|thunder|lightning|typhoon|rain|drizzle|shower|폭풍|태풍|천둥|번개|비(?:가|는|오는|와|옴|내리|중|$)|빗|소나기|장마/.test(normalized)) return "rain";
  if (/fog|mist|cloud|overcast|안개|흐림|흐린|흐려|구름/.test(normalized)) return "cloudy";
  if (/wind|breeze|cool|바람|바람부|선선|시원/.test(normalized)) return "wind";
  if (/hot|heat|humid|muggy|더움|더운|더워|덥|무더|폭염|후덥|습하/.test(normalized)) return "hot";
  if (/cold|chilly|추움|추운|추워|춥|한파/.test(normalized)) return "cold";
  if (/clear|sun|sunny|맑음|맑은|맑아|맑고|화창/.test(normalized)) return "clear";
  return "unknown";
}

export function normalizeActivity(value?: string): ActivityTag | undefined {
  if (!value) return undefined;
  const normalized = compact(value);
  if (/sleep|bed|잠|수면/.test(normalized)) return "sleep";
  if (/study|read|공부|독서/.test(normalized)) return "study";
  if (/work|office|업무|일/.test(normalized)) return "work";
  if (/run|gym|exercise|workout|운동|러닝|헬스/.test(normalized)) return "exercise";
  if (/commute|drive|bus|subway|출근|퇴근|운전|지하철/.test(normalized)) return "commute";
  if (/walk|stroll|산책/.test(normalized)) return "walk";
  return "rest";
}
