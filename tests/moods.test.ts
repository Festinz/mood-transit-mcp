import { describe, expect, it } from "vitest";
import { normalizeMood } from "../src/domain/moods.js";

describe("mood input validation", () => {
  it("maps a natural generic mood-change target to a hopeful journey", () => {
    expect(normalizeMood("기분 전환")).toBe("hopeful");
  });

  it("rejects an unsupported mood instead of silently treating it as neutral", () => {
    expect(() => normalizeMood("형용할 수 없는 상태 xyz"))
      .toThrow("지원하지 않는 기분 표현입니다");
  });
});
