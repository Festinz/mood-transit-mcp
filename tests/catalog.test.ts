import { describe, expect, it } from "vitest";
import { TRACK_CATALOG } from "../src/domain/catalog.js";

describe("curated track catalog", () => {
  it("contains at least 48 unique real-track metadata records across catalog groups", () => {
    expect(TRACK_CATALOG.length).toBeGreaterThanOrEqual(48);
    expect(new Set(TRACK_CATALOG.map((track) => track.id)).size).toBe(TRACK_CATALOG.length);
    expect(TRACK_CATALOG.filter((track) => track.locale === "ko").length).toBeGreaterThanOrEqual(15);
    expect(TRACK_CATALOG.filter((track) => track.locale === "international").length).toBeGreaterThanOrEqual(15);
    expect(TRACK_CATALOG.filter((track) => track.instrumental).length).toBeGreaterThanOrEqual(10);
  });

  it("keeps metadata and editorial scores within integrity bounds", () => {
    for (const track of TRACK_CATALOG) {
      expect(track.id).toMatch(/^[a-z0-9-]{3,80}$/);
      expect(track.title.trim().length).toBeGreaterThan(0);
      expect(track.artist.trim().length).toBeGreaterThan(0);
      expect(track.year).toBeGreaterThanOrEqual(1800);
      expect(track.year).toBeLessThanOrEqual(2026);
      expect(track.durationSec).toBeGreaterThanOrEqual(120);
      expect(track.durationSec).toBeLessThanOrEqual(600);
      for (const value of [track.energy, track.valence, track.acousticness, track.familiarity]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(track.moods.length).toBeGreaterThan(0);
      expect(track.weather.length).toBeGreaterThan(0);
      expect(track.activities.length).toBeGreaterThan(0);
      if (track.locale === "instrumental") expect(track.instrumental).toBe(true);
    }
  });
});
