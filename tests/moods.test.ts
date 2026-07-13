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
