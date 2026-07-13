import { describe, expect, it } from "vitest";
import { interpretMood, musicContextTags, normalizeActivity, normalizeMood, normalizeWeather } from "../src/domain/moods.js";

describe("mood input validation", () => {
  it("maps a natural generic mood-change target to a hopeful journey", () => {
    expect(normalizeMood("기분 전환")).toBe("hopeful");
  });

  it.each([
    ["가라앉음", "sad"],
    ["기분이 안좋은데", "sad"],
    ["기분이 안 좋은데", "sad"],
    ["기분이 안 좋아", "sad"],
    ["기분이 안좋음", "sad"],
    ["오늘 기분이 별로야", "sad"],
    ["좋음", "joyful"],
    ["기분 좋아지는 노래", "joyful"],
    ["좀 더 좋은 기분", "joyful"],
    ["좀 더 밝은 기분", "joyful"],
    ["신나는", "joyful"]
  ] as const)("normalizes conversational model output %s to %s", (input, expected) => {
    expect(normalizeMood(input)).toBe(expected);
  });

  it("rejects an unsupported mood instead of silently treating it as neutral", () => {
    expect(() => normalizeMood("형용할 수 없는 상태 xyz"))
      .toThrow("지원하지 않는 기분 표현입니다");
  });

  it("interprets weather and sensory wording safely at the MCP boundary", () => {
    expect(interpretMood("더운", "content")).toMatchObject({
      mood: "content",
      kind: "descriptor",
      contextTags: expect.arrayContaining(["summer", "chillout"])
    });
    expect(interpretMood("시원한", "content")).toMatchObject({
      mood: "energetic",
      kind: "descriptor",
      contextTags: expect.arrayContaining(["refreshing", "upbeat"])
    });
    expect(normalizeWeather("오늘 너무 더운데")).toBe("hot");
    expect(normalizeWeather("선선하고 시원한 날")).toBe("wind");
    expect(normalizeWeather("맑은 날")).toBe("clear");
    expect(normalizeWeather("흐려요, 안개도 있어요")).toBe("cloudy");
    expect(normalizeWeather("천둥 번개가 치는 폭풍")).toBe("rain");
    expect(normalizeWeather("진눈깨비와 우박")).toBe("snow");
    expect(normalizeWeather("비교적 맑아요")).toBe("clear");
    expect(musicContextTags("폭염", "청량한")).toEqual(expect.arrayContaining([
      "summer",
      "tropical",
      "refreshing",
      "upbeat"
    ]));
  });

  it("does not mistake common negations for the mood, weather, or activity they reject", () => {
    expect(() => normalizeMood("우울하지 않은 상태")).toThrow("지원하지 않는 기분 표현입니다");
    expect(() => normalizeMood("너무 신나지는 않게")).toThrow("지원하지 않는 기분 표현입니다");
    expect(interpretMood("이 곡은 너무 우울해서 빼줘", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 곡은 빼고 다시 추천해줘", "joyful").kind).toBe("default");
    expect(interpretMood("신나는 곡은 싫으니 빼줘", "calm").kind).toBe("default");
    expect(interpretMood("첫 곡이 별로라서 빼줘", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 노래는 안 듣고 싶어", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 곡들은 빼줘", "joyful").kind).toBe("default");
    expect(interpretMood("우울함은 제외해줘", "joyful").kind).toBe("default");
    expect(interpretMood("I don't want sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("sad songs I don't want", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 건 마음에 안 들어", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 건 내 스타일이 아니야", "joyful").kind).toBe("default");
    expect(interpretMood("I don't feel like sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("happy songs aren't what I want", "calm").kind).toBe("default");
    expect(interpretMood("우울한 노래 추천은 하지 마", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 노래를 추천하지는 말아줘", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 곡은 추천 안 해줘도 돼", "joyful").kind).toBe("default");
    expect(interpretMood("I don't need any sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("I wouldn't recommend sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("Don't play sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("sad songs are not what I'm looking for", "joyful").kind).toBe("default");
    expect(interpretMood("차분한 노래는 필요 없어", "joyful").kind).toBe("default");
    expect(interpretMood("차분한 노래 추천할 필요 없어", "joyful").kind).toBe("default");
    expect(interpretMood("차분한 건 원하지는 않아", "joyful").kind).toBe("default");
    expect(interpretMood("차분한 노래는 듣고 싶진 않아", "joyful").kind).toBe("default");
    expect(interpretMood("I don't really want sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("I do not really want sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("No need for sad songs", "joyful").kind).toBe("default");
    expect(interpretMood("우울한 곡은 빼지 말고 추천해줘", "joyful")).toMatchObject({ kind: "mood", mood: "sad" });
    expect(interpretMood("신나는 곡은 싫지 않아", "calm")).toMatchObject({ kind: "mood", mood: "joyful" });
    expect(interpretMood("신나는 건 싫은 건 아니야", "calm")).toMatchObject({ kind: "mood", mood: "joyful" });
    expect(interpretMood("신나는 건 싫지는 않아", "calm")).toMatchObject({ kind: "mood", mood: "joyful" });
    expect(normalizeWeather("오늘은 덥지 않아")).toBe("unknown");
    expect(normalizeWeather("춥지 않은 날")).toBe("unknown");
    expect(normalizeActivity("일요일 드라이브")).toBe("commute");
  });

  it("preserves every non-negated sensory layer in a composite descriptor", () => {
    const interpreted = interpretMood("짜증나지만 시원하고 몽환적인 느낌", "content");
    expect(interpreted.kind).toBe("descriptor");
    expect(interpreted.contextTags).toEqual(expect.arrayContaining([
      "refreshing",
      "dreamy",
      "ambient"
    ]));
    expect(interpreted.vector).toBeDefined();
  });

  it("does not turn an unknown legacy sentence into an external catalog tag", () => {
    expect(interpretMood("창문을 반쯤 열고 해안도로를 천천히 도는 중", "content")).toEqual({
      mood: "content",
      kind: "default",
      contextTags: []
    });
  });
});
