import { describe, expect, it } from "vitest";
import { normalizeMood } from "../src/domain/moods.js";

describe("mood input validation", () => {
  it("rejects an unsupported mood instead of silently treating it as neutral", () => {
    expect(() => normalizeMood("형용할 수 없는 상태 xyz"))
      .toThrow("지원하지 않는 기분 표현입니다");
  });
});
