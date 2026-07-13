import { describe, expect, it } from "vitest";
import { planLiveJourneyBrief, rankExternalCandidates } from "../src/domain/liveJourney.js";
import { MOOD_VECTORS } from "../src/domain/moods.js";
import { CANONICAL_MOODS } from "../src/domain/types.js";
import type { ExternalMusicCandidate } from "../src/domain/liveTypes.js";
import type { CanonicalMood, MoodVector } from "../src/domain/types.js";

function candidate(
  id: string,
  mood: CanonicalMood,
  overrides: Partial<ExternalMusicCandidate> = {}
): ExternalMusicCandidate {
  return {
    id,
    title: `Track ${id}`,
    artist: `Artist ${id}`,
    durationSec: 180,
    provider: "melon",
    tags: [mood],
    ...overrides
  };
}

function projection(vector: MoodVector, from: MoodVector, to: MoodVector): number {
  const delta = {
    valence: to.valence - from.valence,
    energy: to.energy - from.energy,
    acousticness: to.acousticness - from.acousticness
  };
  return (
    (vector.valence - from.valence) * delta.valence +
    (vector.energy - from.energy) * delta.energy +
    (vector.acousticness - from.acousticness) * delta.acousticness
  ) / (delta.valence ** 2 + delta.energy ** 2 + delta.acousticness ** 2);
}

describe("live journey brief", () => {
  it("allocates an exact three-phase budget and explicitly requests authorized music candidates", () => {
    const brief = planLiveJourneyBrief({
      currentMood: "sad",
      targetMood: "hopeful",
      minutes: 25,
      weather: "rain",
      activity: "commute",
      tasteProfile: {
        favoriteGenres: ["indie pop"],
        languagePreference: "korean"
      }
    });

    expect(brief.phases.map((phase) => phase.phase)).toEqual(["mirror", "bridge", "arrive"]);
    expect(brief.phases.reduce((sum, phase) => sum + phase.allocatedSeconds, 0)).toBe(25 * 60);
    expect(brief.phases.every((phase) => phase.tags.length >= 4)).toBe(true);
    expect(brief.phases.every((phase) => phase.searchIntent.length > 30)).toBe(true);
    for (const phase of brief.phases) {
      const melon = phase.candidateRequest.preferredSources.find((source) => source.provider === "official-melon-mcp");
      expect(melon?.tools.length).toBeGreaterThan(0);
      expect(melon?.instruction).toContain("official Melon MCP");
      expect(phase.candidateRequest.requiredFields).toContain("providerUrl");
      expect(phase.candidateRequest.targetCount).toBeGreaterThanOrEqual(6);
    }
    expect(brief.orchestrationNote).toContain("does not proxy, scrape");
  });
});

describe("external candidate ranking", () => {
  it("ranks Melon-like basic metadata by personalization without requiring a fixed catalog", () => {
    const candidates: ExternalMusicCandidate[] = [
      { id: "melon-1", title: "Personal One", artist: "Alpha", provider: "melon", providerUrl: "https://www.melon.com/song/detail.htm?songId=1", personalizationScore: 0.98 },
      { id: "melon-2", title: "Liked Two", artist: "Beta", provider: "melon", liked: true, recentPlayCount: 8 },
      { id: "melon-3", title: "Recent Three", artist: "Gamma", provider: "melon", recentPlayCount: 20 },
      { id: "melon-4", title: "Ordinary Four", artist: "Delta", provider: "melon" },
      { id: "melon-5", title: "Ordinary Five", artist: "Epsilon", provider: "melon" },
      { id: "melon-6", title: "Ordinary Six", artist: "Zeta", provider: "melon" }
    ];

    const journey = rankExternalCandidates({
      currentMood: "sad",
      targetMood: "hopeful",
      minutes: 15,
      tasteProfile: { familiarVsDiscovery: 0.9 }
    }, candidates);

    expect(journey.tracks.length).toBeGreaterThanOrEqual(3);
    expect(journey.tracks.map((track) => track.id)).toContain("melon-1");
    expect(journey.tracks.map((track) => track.id)).toContain("melon-2");
    expect(journey.estimatedMinutes).toBeLessThanOrEqual(15);
    expect(journey.tracks.find((track) => track.id === "melon-1")?.providerUrl).toBe("https://www.melon.com/song/detail.htm?songId=1");
    expect(journey.tracks.every((track) => track.links.youtubeMusicSearch.startsWith("https://music.youtube.com/search?q="))).toBe(true);
    expect(journey.tracks.every((track) => track.links.melonSearch.startsWith("https://www.melon.com/search/total/index.htm?q="))).toBe(true);
    expect(journey.tracks.some((track) => track.reason.includes("provider personalization"))).toBe(true);
  });

  it("uses context-matching candidates first and explicitly marks a necessary broadening", () => {
    const strict = rankExternalCandidates({
      currentMood: "content",
      targetMood: "energetic",
      minutes: 12,
      desiredVibe: "시원한",
      contextTags: ["refreshing", "upbeat"]
    }, [
      candidate("refresh-1", "content", { tags: ["content", "refreshing"] }),
      candidate("refresh-2", "joyful", { tags: ["joyful", "upbeat"] }),
      candidate("refresh-3", "energetic", { tags: ["energetic", "refreshing"] }),
      candidate("unrelated-1", "content", { personalizationScore: 1 }),
      candidate("unrelated-2", "joyful", { personalizationScore: 1 }),
      candidate("unrelated-3", "energetic", { personalizationScore: 1 })
    ]);
    expect(strict.context.contextMatchMode).toBe("strict");
    expect(strict.tracks.every((track) => track.id.startsWith("refresh-"))).toBe(true);
    expect(strict.context.sourceNote).toContain("Ranked 3 of 6");

    const broadened = rankExternalCandidates({
      currentMood: "content",
      targetMood: "energetic",
      minutes: 12,
      contextTags: ["refreshing"]
    }, [
      candidate("only-refresh-1", "content", { tags: ["content", "refreshing"] }),
      candidate("only-refresh-2", "energetic", { tags: ["energetic", "refreshing"] }),
      candidate("general-1", "content"),
      candidate("general-2", "joyful"),
      candidate("general-3", "energetic")
    ]);
    expect(broadened.context.contextMatchMode).toBe("broadened");
    expect(broadened.tracks.length).toBeGreaterThanOrEqual(3);
  });

  it("broadens a context pool that has three matches but cannot fill three stages within the budget", () => {
    const journey = rankExternalCandidates({
      currentMood: "content",
      targetMood: "energetic",
      minutes: 10,
      contextTags: ["refreshing"]
    }, [
      candidate("refresh-long-1", "content", { durationSec: 301, tags: ["content", "refreshing"] }),
      candidate("refresh-long-2", "joyful", { durationSec: 301, tags: ["joyful", "refreshing"] }),
      candidate("refresh-long-3", "energetic", { durationSec: 301, tags: ["energetic", "refreshing"] }),
      candidate("general-1", "content"),
      candidate("general-2", "joyful"),
      candidate("general-3", "energetic")
    ]);

    expect(journey.context.contextMatchMode).toBe("broadened");
    expect(journey.tracks).toHaveLength(3);
    expect(journey.tracks.every((track) => track.id.startsWith("general-"))).toBe(true);
    expect(journey.context.sourceNote).toContain("Ranked 6 of 6");
  });

  it("deduplicates cross-provider recordings and is deterministic independent of input order", () => {
    const sharedMelon = candidate("melon-shared", "calm", {
      title: "Same Song",
      artist: "Same Artist",
      provider: "melon",
      providerUrl: "https://www.melon.com/song/detail.htm?songId=7",
      liked: true
    });
    const sharedYouTube = candidate("youtube-shared", "calm", {
      title: "Same Song",
      artist: "Same Artist",
      provider: "youtube",
      providerUrl: "https://www.youtube.com/watch?v=example"
    });
    const candidates = [
      sharedYouTube,
      candidate("bridge", "content"),
      candidate("arrive", "joyful"),
      sharedMelon,
      candidate("extra", "hopeful")
    ];
    const options = { currentMood: "calm", targetMood: "joyful", minutes: 12 } as const;

    const first = rankExternalCandidates(options, candidates);
    const second = rankExternalCandidates(options, [...candidates].reverse());

    expect(first).toEqual(second);
    expect(first.tracks.filter((track) => track.title === "Same Song")).toHaveLength(1);
    expect(first.tracks.find((track) => track.title === "Same Song")?.provider).toBe("melon");
    expect(new Set(first.tracks.map((track) => `${track.artist}|${track.title}`)).size).toBe(first.tracks.length);
  });

  it("honors avoid lists, language, instrumental, exclusions, and time", () => {
    const candidates: ExternalMusicCandidate[] = [
      candidate("piano-1", "calm", { artist: "Keep One", instrumental: true, language: "instrumental", genres: ["classical"] }),
      candidate("piano-2", "focused", { artist: "Keep Two", instrumental: true, language: "instrumental", genres: ["ambient"] }),
      candidate("piano-3", "hopeful", { artist: "Keep Three", instrumental: true, language: "instrumental", genres: ["post-rock"] }),
      candidate("piano-4", "focused", { artist: "Keep Four", instrumental: true, language: "instrumental", genres: ["classical"] }),
      candidate("avoid-artist", "focused", { artist: "Blocked Artist", instrumental: true, language: "instrumental" }),
      candidate("avoid-genre", "hopeful", { artist: "Other", instrumental: true, language: "instrumental", tags: ["hopeful", "metal"] }),
      candidate("vocal", "hopeful", { artist: "Singer", instrumental: false, language: "ko" })
    ];

    const journey = rankExternalCandidates({
      currentMood: "tired",
      targetMood: "focused",
      minutes: 10,
      excludedCandidateIds: ["piano-2"],
      tasteProfile: {
        instrumentalOnly: true,
        avoidArtists: ["Blocked Artist"],
        avoidGenres: ["metal"]
      }
    }, candidates);

    expect(journey.tracks.every((track) => track.instrumental)).toBe(true);
    expect(journey.tracks.some((track) => track.artist === "Blocked Artist")).toBe(false);
    expect(journey.tracks.some((track) => track.id === "avoid-genre")).toBe(false);
    expect(journey.tracks.some((track) => track.id === "piano-2")).toBe(false);
    expect(journey.estimatedMinutes).toBeLessThanOrEqual(10);

    const korean = rankExternalCandidates({
      currentMood: "sad",
      targetMood: "joyful",
      minutes: 10,
      tasteProfile: { languagePreference: "korean" }
    }, [
      candidate("ko-1", "sad", { language: "ko" }),
      candidate("ko-2", "content", { language: "korean" }),
      candidate("ko-3", "joyful", { language: "한국어" }),
      candidate("en-1", "joyful", { language: "en" })
    ]);
    expect(korean.tracks).toHaveLength(3);
    expect(korean.tracks.every((track) => track.id.startsWith("ko-"))).toBe(true);
  });

  it("can restrict a journey to a named artist and prioritize an explicitly named song", () => {
    const candidates: ExternalMusicCandidate[] = [
      candidate("rescene-mirror", "sad", { artist: "RESCENE", title: "Pinball" }),
      candidate("rescene-bridge", "content", { artist: "RESCENE", title: "LOVE ATTACK" }),
      candidate("rescene-arrive", "joyful", { artist: "RESCENE", title: "Glow Up" }),
      candidate("rescene-extra", "hopeful", { artist: "RESCENE", title: "Counting Star" }),
      candidate("other-mirror", "sad", { artist: "Other Artist" }),
      candidate("other-bridge", "content", { artist: "Other Artist 2" }),
      candidate("other-arrive", "joyful", { artist: "Other Artist 3" })
    ];

    const journey = rankExternalCandidates({
      currentMood: "sad",
      targetMood: "joyful",
      minutes: 12,
      tasteProfile: {
        favoriteArtists: ["RESCENE"],
        favoriteTracks: ["LOVE ATTACK"],
        artistScope: "only"
      }
    }, candidates);

    expect(journey.tracks.length).toBeGreaterThanOrEqual(3);
    expect(journey.tracks.every((track) => track.artist === "RESCENE")).toBe(true);
    expect(journey.tracks.some((track) => track.title === "LOVE ATTACK")).toBe(true);
    expect(journey.tracks.find((track) => track.title === "LOVE ATTACK")?.reason).toContain("지정 곡");
  });

  it("keeps phase progress nondecreasing for every canonical mood pair", () => {
    for (const currentMood of CANONICAL_MOODS) {
      for (const targetMood of CANONICAL_MOODS) {
        const candidates: ExternalMusicCandidate[] = [
          candidate(`${currentMood}-${targetMood}-mirror`, currentMood),
          candidate(`${currentMood}-${targetMood}-bridge`, currentMood, { tags: [currentMood, targetMood] }),
          candidate(`${currentMood}-${targetMood}-arrive`, targetMood)
        ];
        const journey = rankExternalCandidates({ currentMood, targetMood, minutes: 10 }, candidates);
        expect(journey.tracks.map((track) => track.phase), `${currentMood} -> ${targetMood}`).toEqual(["mirror", "bridge", "arrive"]);

        if (currentMood !== targetMood) {
          const from = MOOD_VECTORS[currentMood];
          const to = MOOD_VECTORS[targetMood];
          const progress = journey.tracks.map((track) => projection(MOOD_VECTORS[track.inferredMood], from, to));
          expect(progress[1]!, `${currentMood} -> ${targetMood}, Mirror -> Bridge`).toBeGreaterThanOrEqual(progress[0]! - 1e-9);
          expect(progress[2]!, `${currentMood} -> ${targetMood}, Bridge -> Arrive`).toBeGreaterThanOrEqual(progress[1]! - 1e-9);
        }
      }
    }
  }, 20_000);

  it("rejects more than 100 candidates", () => {
    const candidates = Array.from({ length: 101 }, (_, index) => candidate(`track-${index}`, "content"));
    expect(() => rankExternalCandidates({ currentMood: "content", targetMood: "joyful", minutes: 20 }, candidates)).toThrow("at most 100");
  });
});
