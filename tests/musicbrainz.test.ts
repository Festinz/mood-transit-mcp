import { describe, expect, it, vi } from "vitest";
import {
  MUSICBRAINZ_ATTRIBUTION,
  MusicBrainzService,
  MusicBrainzServiceError,
  type MusicBrainzCandidateQuery
} from "../src/services/musicbrainz.js";

const RESCENE_MBID = "a54fd8e2-d319-44a6-aa60-21adf17751bf";
const OTHER_ARTIST_MBID = "8da127cc-c432-418f-b356-ef36210d82ac";
const LOVE_ATTACK_MBID = "11111111-2222-4333-8444-555555555555";
const LIVE_RECORDING_MBID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function artistSearchFixture(): Record<string, unknown> {
  return {
    created: "2026-07-13T00:00:00Z",
    count: 1,
    offset: 0,
    artists: [{
      id: RESCENE_MBID,
      name: "RESCENE",
      score: 100,
      aliases: [
        { name: "RESCENE", locale: "en", primary: true },
        { name: "리센느", locale: "ko", primary: true }
      ]
    }]
  };
}

function recordingFixture(
  id = LOVE_ATTACK_MBID,
  title = "LOVE ATTACK",
  artistMbid = RESCENE_MBID,
  artistName = "RESCENE"
): Record<string, unknown> {
  return {
    id,
    score: 100,
    title,
    length: 179_400,
    "first-release-date": "2024-08-27",
    "artist-credit": [{ name: artistName, artist: { id: artistMbid, name: artistName } }],
    isrcs: ["KRA382400001"],
    releases: [{ id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", title: "SCENEDROME", date: "2024-08-27" }],
    tags: [{ name: "k-pop", count: 4 }, { name: "dance-pop", count: 2 }],
    genres: [{ name: "K-pop", count: 2 }]
  };
}

describe("MusicBrainz service", () => {
  it("resolves the Korean alias 리센느 to RESCENE and searches recordings by its MBID and exact title", async () => {
    let now = Date.UTC(2026, 6, 13);
    const startedAt = now;
    const requestTimes: number[] = [];
    const observedUrls: URL[] = [];
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const mockFetch = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      observedUrls.push(url);
      requestTimes.push(now);
      expect(url.origin).toBe("https://musicbrainz.org");
      expect(url.pathname.startsWith("/ws/2/")).toBe(true);
      expect(init.redirect).toBe("manual");
      const headers = new Headers(init.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("user-agent")).toContain("MoodTransit/2.2");
      expect(headers.get("user-agent")).toContain("github.com/Festinz/mood-transit-mcp");

      if (url.pathname === "/ws/2/artist/") {
        expect(url.searchParams.get("fmt")).toBe("json");
        expect(url.searchParams.get("query")).toBe('(artist:"리센느" OR alias:"리센느")');
        return jsonResponse(artistSearchFixture());
      }
      if (url.pathname === "/ws/2/recording/") {
        const query = url.searchParams.get("query") ?? "";
        expect(query).toContain(`arid:${RESCENE_MBID}`);
        expect(query).toContain('recording:"LOVE ATTACK"');
        return jsonResponse({ count: 1, offset: 0, recordings: [recordingFixture()] });
      }
      return new Response(null, { status: 404 });
    });

    const service = new MusicBrainzService({ fetchImpl: mockFetch, now: () => now, sleep });
    const result = await service.searchCandidates({
      artists: [" 리센느 "],
      trackTitles: ["LOVE ATTACK"],
      count: 5
    });

    expect(result).toMatchObject({
      source: "musicbrainz-live",
      attribution: MUSICBRAINZ_ATTRIBUTION,
      matchedArtists: [{
        requestedName: "리센느",
        name: "RESCENE",
        mbid: RESCENE_MBID,
        matchedBy: "alias",
        matchedAlias: "리센느"
      }],
      matchedArtistNames: ["RESCENE"],
      matchedArtistMbids: [RESCENE_MBID]
    });
    expect(result.candidates).toEqual([expect.objectContaining({
      id: `musicbrainz:${LOVE_ATTACK_MBID}`,
      title: "LOVE ATTACK",
      artist: "RESCENE",
      durationSec: 179,
      provider: "musicbrainz",
      providerUrl: `https://musicbrainz.org/recording/${LOVE_ATTACK_MBID}`,
      recordingMbid: LOVE_ATTACK_MBID,
      artistMbid: RESCENE_MBID,
      artistMbids: [RESCENE_MBID],
      isrc: "KRA382400001",
      releaseTitle: "SCENEDROME",
      releaseYear: 2024
    })]);
    expect(result.candidates[0]?.tags).toEqual(expect.arrayContaining(["k-pop", "dance-pop"]));
    expect(requestTimes).toEqual([startedAt, startedAt + 1_000]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(observedUrls).toHaveLength(2);
  });

  it("post-filters MusicBrainz phrase hits so only an exact normalized track title is returned", async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/ws/2/recording/");
      expect(url.searchParams.get("query")).toBe('(recording:"love attack")');
      return jsonResponse({
        count: 2,
        offset: 0,
        recordings: [
          recordingFixture(),
          recordingFixture(LIVE_RECORDING_MBID, "LOVE ATTACK (Live)", OTHER_ARTIST_MBID, "Other Artist")
        ]
      });
    });
    const service = new MusicBrainzService({ fetchImpl: mockFetch });

    const result = await service.searchCandidates({ trackTitles: ["  love   attack "] });

    expect(result.candidates.map((candidate) => candidate.recordingMbid)).toEqual([LOVE_ATTACK_MBID]);
    expect(result.matchedArtists).toEqual([]);
  });

  it("searches the public recording catalog by bounded mood and context tags", async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/ws/2/recording/");
      expect(url.searchParams.get("query")).toBe('(tag:"refreshing" OR tag:"summer" OR tag:"Upbeat")');
      return jsonResponse({
        count: 3,
        offset: 0,
        recordings: [
          recordingFixture(LOVE_ATTACK_MBID, "Summer One", RESCENE_MBID, "RESCENE"),
          recordingFixture(LIVE_RECORDING_MBID, "Fresh Two", OTHER_ARTIST_MBID, "Other Artist"),
          recordingFixture("cccccccc-dddd-4eee-8fff-000000000000", "Upbeat Three", "dddddddd-eeee-4fff-8000-111111111111", "Third Artist")
        ]
      });
    });
    const service = new MusicBrainzService({ fetchImpl: mockFetch });

    const result = await service.searchCandidates({
      tags: [" Upbeat ", "refreshing", "summer", "upbeat"],
      count: 12
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.provider === "musicbrainz")).toBe(true);
    expect(result.matchedArtists).toEqual([]);
  });

  it("deduplicates equivalent in-flight searches and serves defensive copies from the bounded TTL cache", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockFetch = vi.fn<typeof fetch>(async () => {
      await gate;
      return jsonResponse({ recordings: [recordingFixture()] });
    });
    const service = new MusicBrainzService({ fetchImpl: mockFetch });

    const first = service.searchCandidates({ trackTitles: [" LOVE ATTACK "] });
    const second = service.searchCandidates({ trackTitles: ["love   attack"] });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.source).toBe("musicbrainz-live");
    expect(secondResult.source).toBe("musicbrainz-live");
    firstResult.candidates[0]!.title = "mutated by caller";
    firstResult.candidates[0]!.artistMbids!.push(OTHER_ARTIST_MBID);
    expect(secondResult.candidates[0]?.title).toBe("LOVE ATTACK");
    expect(secondResult.candidates[0]?.artistMbids).toEqual([RESCENE_MBID]);

    const cached = await service.searchCandidates({ trackTitles: ["love attack"] });
    expect(cached.source).toBe("musicbrainz-cache");
    expect(cached.candidates[0]?.title).toBe("LOVE ATTACK");
    expect(cached.candidates[0]?.artistMbids).toEqual([RESCENE_MBID]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent upstream searches at one request per second", async () => {
    let now = 0;
    const requestTimes: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const mockFetch = vi.fn<typeof fetch>(async () => {
      requestTimes.push(now);
      return jsonResponse({ recordings: [] });
    });
    const service = new MusicBrainzService({ fetchImpl: mockFetch, now: () => now, sleep });

    await Promise.all([
      service.searchCandidates({ trackTitles: ["First song"] }),
      service.searchCandidates({ trackTitles: ["Second song"] })
    ]);

    expect(requestTimes).toEqual([0, 1_000]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
  });

  it("rejects redirects, escaped origins, malformed or oversized JSON, and exposes upstream rate limits", async () => {
    const redirectService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/metadata" }
      }))
    });
    await expect(redirectService.searchCandidates({ trackTitles: ["song"] })).rejects.toMatchObject({
      name: "MusicBrainzServiceError",
      code: "UPSTREAM_REDIRECT",
      retryable: false,
      status: 302
    });

    const escapedResponse = jsonResponse({ recordings: [] });
    Object.defineProperty(escapedResponse, "url", { value: "https://attacker.example/ws/2/recording/" });
    const escapedOriginService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(escapedResponse)
    });
    await expect(escapedOriginService.searchCandidates({ trackTitles: ["song"] })).rejects.toMatchObject({
      code: "UPSTREAM_REDIRECT"
    });

    const malformedService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("{not-json", {
        headers: { "content-type": "application/json" }
      }))
    });
    await expect(malformedService.searchCandidates({ trackTitles: ["song"] })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false
    });

    const oversizedService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "999999" }
      })),
      maxResponseBytes: 256
    });
    await expect(oversizedService.searchCandidates({ trackTitles: ["song"] })).rejects.toMatchObject({
      code: "INVALID_RESPONSE"
    });

    const rateLimitedService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "slow down" }, {
        status: 429,
        headers: { "retry-after": "0.5" }
      }))
    });
    await expect(rateLimitedService.searchCandidates({ trackTitles: ["song"] })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 500,
      retryable: true
    });

    const officialThrottleService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    });
    await expect(officialThrottleService.searchCandidates({ trackTitles: ["song"] })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 503,
      retryAfterMs: 1_000,
      retryable: true
    });
  });

  it("supports an MBID-qualified exact-title query without repeating artist-name resolution", async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/ws/2/recording/");
      expect(url.searchParams.get("query")).toContain(`arid:${RESCENE_MBID}`);
      expect(url.searchParams.get("query")).toContain('recording:"LOVE ATTACK"');
      expect(url.searchParams.get("limit")).toBe("16");
      return jsonResponse({ recordings: [recordingFixture()] });
    });
    const service = new MusicBrainzService({ fetchImpl: mockFetch });

    const result = await service.searchCandidates({
      artistMbids: [RESCENE_MBID],
      trackTitles: ["LOVE ATTACK"],
      count: 16
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ title: "LOVE ATTACK", artist: "RESCENE" });
    expect(result.matchedArtistMbids).toEqual([RESCENE_MBID]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects exact same-name artists regardless of score and returns fixed-origin options", async () => {
    const phoenixFetch = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/ws/2/artist/") {
        return jsonResponse({ artists: [
          { id: RESCENE_MBID, name: "Phoenix", score: 100, aliases: [] },
          { id: OTHER_ARTIST_MBID, name: "Phoenix", score: 40, aliases: [] }
        ] });
      }
      return jsonResponse({ recordings: [recordingFixture()] });
    });
    const service = new MusicBrainzService({ fetchImpl: phoenixFetch, sleep: async () => undefined });
    await expect(service.searchCandidates({ artists: ["Phoenix"], count: 1 })).rejects.toMatchObject({
      code: "AMBIGUOUS_ARTIST",
      retryable: false,
      message: expect.stringContaining(`https://musicbrainz.org/artist/${RESCENE_MBID}`)
    });
    expect(phoenixFetch).toHaveBeenCalledTimes(1);

    const closeAliasService = new MusicBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ artists: [
        { id: RESCENE_MBID, name: "First Artist", score: 100, aliases: [{ name: "Same Alias" }] },
        { id: OTHER_ARTIST_MBID, name: "Second Artist", score: 97, aliases: [{ name: "Same Alias" }] }
      ] }))
    });
    await expect(closeAliasService.searchCandidates({ artists: ["Same Alias"] })).rejects.toMatchObject({
      code: "AMBIGUOUS_ARTIST",
      retryable: false
    });
  });

  it("caps distinct in-flight searches instead of growing an unbounded rate-limit queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockFetch = vi.fn<typeof fetch>(async () => {
      await gate;
      return jsonResponse({ recordings: [] });
    });
    const service = new MusicBrainzService({ fetchImpl: mockFetch, maxInFlightQueries: 1 });
    const first = service.searchCandidates({ trackTitles: ["First"] });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await expect(service.searchCandidates({ trackTitles: ["Second"] })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
    release();
    await expect(first).resolves.toMatchObject({ candidates: [] });
  });

  it("enforces one total deadline across artist resolution and the required rate-limit wait", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(artistSearchFixture()));
    const service = new MusicBrainzService({
      fetchImpl: mockFetch,
      deadlineMs: 500,
      now: () => now,
      sleep
    });

    await expect(service.searchCandidates({ artists: ["리센느"], trackTitles: ["LOVE ATTACK"] }))
      .rejects.toMatchObject({
        code: "DEADLINE_EXCEEDED",
        retryable: true
      });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects unbounded or invalid caller input before network access", async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const service = new MusicBrainzService({ fetchImpl: mockFetch });
    const invalidInputs: unknown[] = [
      {},
      { artists: "RESCENE" },
      { artists: Array.from({ length: 6 }, (_, index) => `artist-${index}`) },
      { artistMbids: Array.from({ length: 6 }, () => RESCENE_MBID) },
      { artistMbids: ["not-an-mbid"] },
      { trackTitles: Array.from({ length: 13 }, (_, index) => `track-${index}`) },
      { tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`) },
      { artists: ["RESCENE\nInjected"] },
      { tags: ["summer\nInjected"] },
      { trackTitles: ["x".repeat(161)] },
      { trackTitles: ["song"], count: 0 },
      { trackTitles: ["song"], count: 1.5 },
      null,
      []
    ];
    for (const input of invalidInputs) {
      await expect(service.searchCandidates(input as MusicBrainzCandidateQuery))
        .rejects.toBeInstanceOf(MusicBrainzServiceError);
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(() => new MusicBrainzService({ cacheTtlMs: 600_001 })).toThrow(MusicBrainzServiceError);
    expect(() => new MusicBrainzService({ userAgent: "anonymous" })).toThrow(MusicBrainzServiceError);
    expect(() => new MusicBrainzService({ userAgent: "MoodTransit/2.2" })).toThrow(MusicBrainzServiceError);
  });
});
