import { describe, expect, it } from "vitest";
import { normalizeMood } from "../src/domain/moods.js";

describe("mood input validation", () => {
  it("maps a natural generic mood-change target to a hopeful journey", () => {
    expect(normalizeMood("기분 전환")).toBe("hopeful");
  });

  it.each([
    ["가라앉음", "sad"],
    ["기분이 안좋은데", "sad"],
    ["기분이 안 좋은데", "sad"],
    ["기분이 안 좋아", "sad"],
    ["오늘 기분이 별로야", "sad"],
    ["좀 더 밝은 기분", "joyful"],
    ["신나는", "joyful"]
  ] as const)("normalizes conversational model output %s to %s", (input, expected) => {
    expect(normalizeMood(input)).toBe(expected);
  });

  it("rejects an unsupported mood instead of silently treating it as neutral", () => {
    expect(() => normalizeMood("형용할 수 없는 상태 xyz"))
      .toThrow("지원하지 않는 기분 표현입니다");
  });
});
