import { describe, expect, it } from "vitest";
import { TRACK_BY_ID } from "../src/domain/catalog.js";
import { buildJourney, refineJourney } from "../src/domain/journey.js";
import { MOOD_VECTORS, normalizeMood } from "../src/domain/moods.js";
import { CANONICAL_MOODS } from "../src/domain/types.js";
import type { JourneyTrack, MoodVector } from "../src/domain/types.js";

function projection(track: JourneyTrack, from: MoodVector, to: MoodVector): number {
  const delta = {
    valence: to.valence - from.valence,
    energy: to.energy - from.energy,
    acousticness: to.acousticness - from.acousticness
  };
  return (
    (track.valence - from.valence) * delta.valence +
    (track.energy - from.energy) * delta.energy +
    (track.acousticness - from.acousticness) * delta.acousticness
  ) / (delta.valence ** 2 + delta.energy ** 2 + delta.acousticness ** 2);
}

function centroidDistance(tracks: JourneyTrack[], target: MoodVector): number {
  const centroid = {
    valence: tracks.reduce((sum, track) => sum + track.valence, 0) / tracks.length,
    energy: tracks.reduce((sum, track) => sum + track.energy, 0) / tracks.length,
    acousticness: tracks.reduce((sum, track) => sum + track.acousticness, 0) / tracks.length
  };
  return Math.hypot(centroid.valence - target.valence, centroid.energy - target.energy, centroid.acousticness - target.acousticness);
}

describe("mood normalization and deterministic journey", () => {
  it.each([
    ["울적해", "sad"],
    ["스트레스 받음", "anxious"],
    ["피곤", "tired"],
    ["편안함", "calm"],
    ["happy", "joyful"],
    ["more focus", "focused"]
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeMood(input)).toBe(expected);
  });

  it("orders mirror, bridge, arrive, stays within duration, and returns no duplicates", () => {
    const journey = buildJourney({ currentMood: "우울", targetMood: "신남", weather: "비", activity: "퇴근", minutes: 30 });
    expect(journey.tracks.length).toBeGreaterThanOrEqual(3);
    expect(journey.tracks.map((track) => track.phase)).toEqual([...journey.tracks.map(() => "mirror").slice(0, journey.tracks.filter((t) => t.phase === "mirror").length), ...journey.tracks.map(() => "bridge").slice(0, journey.tracks.filter((t) => t.phase === "bridge").length), ...journey.tracks.map(() => "arrive").slice(0, journey.tracks.filter((t) => t.phase === "arrive").length)]);
    expect(new Set(journey.tracks.map((track) => track.id)).size).toBe(journey.tracks.length);
    expect(journey.estimatedMinutes).toBeLessThanOrEqual(30);
    expect(journey.tracks.map((track) => track.position)).toEqual(journey.tracks.map((_, index) => index + 1));
    expect(journey.tracks.every((track) => track.reason.length > 20)).toBe(true);
  });

  it("is deterministic for identical input", () => {
    const input = { currentMood: "anxious", targetMood: "calm", activity: "study", minutes: 25 } as const;
    expect(buildJourney(input)).toEqual(buildJourney(input));
  });

  it("moves progressively toward the target for all 132 distinct canonical mood pairs", () => {
    for (const currentMood of CANONICAL_MOODS) {
      for (const targetMood of CANONICAL_MOODS) {
        if (currentMood === targetMood) continue;
        const label = `${currentMood} -> ${targetMood}`;
        const journey = buildJourney({ currentMood, targetMood, minutes: 30 });
        const from = MOOD_VECTORS[currentMood];
        const target = MOOD_VECTORS[targetMood];
        const trackProgress = journey.tracks.map((track) => projection(track, from, target));
        for (let index = 1; index < trackProgress.length; index += 1) {
          expect(trackProgress[index]!, `${label}, track ${index + 1}`).toBeGreaterThanOrEqual(trackProgress[index - 1]! - 1e-9);
        }

        const phaseProgress = (["mirror", "bridge", "arrive"] as const).map((phase) => {
          const tracks = journey.tracks.filter((track) => track.phase === phase);
          return tracks.reduce((sum, track) => sum + projection(track, from, target), 0) / tracks.length;
        });
        expect(phaseProgress[1]!, `${label}, Mirror -> Bridge`).toBeGreaterThanOrEqual(phaseProgress[0]! - 1e-9);
        expect(phaseProgress[2]!, `${label}, Bridge -> Arrive`).toBeGreaterThanOrEqual(phaseProgress[1]! - 1e-9);

        const phaseDistances = (["mirror", "bridge", "arrive"] as const).map((phase) => centroidDistance(
          journey.tracks.filter((track) => track.phase === phase),
          target
        ));
        expect(phaseDistances[1]!, `${label}, Bridge centroid`).toBeLessThanOrEqual(phaseDistances[0]! + 1e-9);
        expect(phaseDistances[2]!, `${label}, Arrive centroid`).toBeLessThanOrEqual(phaseDistances[1]! + 1e-9);
      }
    }
  }, 20_000);

  it("honors instrumental, language, artist avoidance, and short time constraints", () => {
    const instrumental = buildJourney({ currentMood: "tired", targetMood: "focused", minutes: 10, instrumentalOnly: true, avoidArtists: ["Yiruma"] });
    expect(instrumental.tracks.every((track) => track.instrumental)).toBe(true);
    expect(instrumental.tracks.some((track) => track.artist === "Yiruma")).toBe(false);
    expect(instrumental.estimatedMinutes).toBeLessThanOrEqual(10);

    const korean = buildJourney({ currentMood: "sad", targetMood: "hopeful", minutes: 20, languagePreference: "korean", avoidArtists: ["IU", "BTS"] });
    expect(korean.tracks.every((track) => track.locale === "ko")).toBe(true);
    expect(korean.tracks.some((track) => ["IU", "BTS"].includes(track.artist))).toBe(false);
  });

  it("refines without previous tracks while preserving the prior arc, time, context, and familiarity direction", () => {
    const original = buildJourney({ currentMood: "sad", targetMood: "hopeful", minutes: 20 });
    const previousTrackIds = original.tracks.map((track) => track.id);
    const prior = {
      previousTrackIds,
      previousCurrentMood: "sad",
      previousTargetMood: "hopeful",
      previousRequestedMinutes: 20,
      previousContext: { weather: "rain", activity: "commute", languagePreference: "any" as const }
    };
    const familiar = refineJourney({ ...prior, feedback: "more_familiar" });
    const discovery = refineJourney({ ...prior, feedback: "more_discovery" });
    expect(familiar.tracks.every((track) => !previousTrackIds.includes(track.id))).toBe(true);
    expect(discovery.tracks.every((track) => !previousTrackIds.includes(track.id))).toBe(true);
    expect(familiar).toEqual(expect.objectContaining({ currentMood: "sad", targetMood: "hopeful", requestedMinutes: 20 }));
    expect(familiar.context).toEqual(expect.objectContaining({ weather: "rain", activity: "commute", languagePreference: "any" }));
    expect(discovery).toEqual(expect.objectContaining({ currentMood: "sad", targetMood: "hopeful", requestedMinutes: 20 }));
    const avg = (ids: string[]) => ids.reduce((sum, id) => sum + (TRACK_BY_ID.get(id)?.familiarity ?? 0), 0) / ids.length;
    expect(avg(familiar.tracks.map((track) => track.id))).toBeGreaterThanOrEqual(avg(discovery.tracks.map((track) => track.id)));
  });

  it.each([
    ["brighter", "valence", 1],
    ["more_energy", "energy", 1],
    ["less_energy", "energy", -1]
  ] as const)("applies %s relative to the previous target", (feedback, axis, direction) => {
    const original = buildJourney({ currentMood: "sad", targetMood: "hopeful", minutes: 20 });
    const refined = refineJourney({
      previousTrackIds: original.tracks.map((track) => track.id),
      previousCurrentMood: original.currentMood,
      previousTargetMood: original.targetMood,
      previousRequestedMinutes: original.requestedMinutes,
      feedback
    });
    const before = MOOD_VECTORS[original.targetMood][axis];
    const after = MOOD_VECTORS[refined.targetMood][axis];
    expect((after - before) * direction).toBeGreaterThan(0);
    expect(refined.currentMood).toBe(original.currentMood);
  });

  it("caps requests at 60 minutes so the 18-track limit does not underfill long requests", () => {
    expect(() => buildJourney({ currentMood: "sad", targetMood: "hopeful", minutes: 61 })).toThrow("10~60");
    const longest = buildJourney({ currentMood: "sad", targetMood: "hopeful", minutes: 60 });
    expect(longest.tracks.length).toBeGreaterThanOrEqual(17);
    expect(longest.estimatedMinutes).toBeGreaterThanOrEqual(50);
    expect(longest.estimatedMinutes).toBeLessThanOrEqual(60);
  });

  it("generates metadata search links only", () => {
    const journey = buildJourney({ currentMood: "calm", targetMood: "joyful", minutes: 15 });
    for (const track of journey.tracks) {
      expect(track.links.youtubeMusic).toMatch(/^https:\/\/music\.youtube\.com\/search\?q=/);
      expect(track.links.secondary).toMatch(/^https:\/\/(www\.melon\.com\/search\/total\/index\.htm\?q=|open\.spotify\.com\/search\/)/);
      expect(track.links.youtubeMusic).not.toContain("watch?");
      expect(track.links.secondary).not.toContain("/track/");
    }
  });

  it("uses natural Korean mood labels in track reasons", () => {
    const journey = buildJourney({ currentMood: "sad", targetMood: "hopeful", minutes: 20 });
    expect(journey.tracks.some((track) => track.reason.includes("울적"))).toBe(true);
    expect(journey.tracks.some((track) => track.reason.includes("희망"))).toBe(true);
    expect(journey.tracks.every((track) => !track.reason.includes("(으)로"))).toBe(true);
  });
});
