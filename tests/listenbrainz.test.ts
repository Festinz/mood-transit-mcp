import { describe, expect, it, vi } from "vitest";
import {
  LISTENBRAINZ_ATTRIBUTION,
  ListenBrainzService,
  ListenBrainzServiceError
} from "../src/services/listenbrainz.js";

const RECORDING_A = "2007b5be-2a0f-47fc-8f9b-2965d0156bbb";
const RECORDING_B = "32d8536f-64f9-46e8-97e5-b7d401cd7e9a";
const RECORDING_C = "a7aec288-5aa5-472d-83fc-aa5315103b80";
const TWICE_MBID = "8da127cc-c432-418f-b356-ef36210d82ac";
const BTS_MBID = "0d79fe8e-ba27-4859-bb8c-2f255f346853";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function metadataFixture(): Record<string, unknown> {
  return {
    [RECORDING_A]: {
      artist: {
        name: "TWICE",
        artists: [{ artist_mbid: TWICE_MBID, name: "TWICE", area: "South Korea" }]
      },
      recording: {
        name: "SET ME FREE",
        length: 181_680,
        first_release_date: "2023-03-10",
        isrcs: ["US5TA2300010"]
      },
      release: { name: "READY TO BE", year: 2023 },
      tag: {
        artist: [
          { tag: "k-pop", genre_mbid: "b74b3b6c-0700-46b1-aa55-1f2869a3bd1a" },
          { tag: "korean" },
          { tag: "dance-pop", genre_mbid: "b739a895-85ed-4ad3-8717-4e9ef5387dd8" }
        ],
        recording: [],
        release_group: [{ tag: "ep" }]
      }
    },
    [RECORDING_B]: {
      artist: {
        name: "VIXX",
        artists: [{ artist_mbid: "270bebcb-f400-4912-a8ed-1827ae562405", name: "VIXX" }]
      },
      recording: {
        name: "태어나줘서 고마워",
        length: 258_773,
        first_release_date: "2013-11-25",
        isrcs: ["KRA491301533"]
      },
      release: { name: "VOODOO", year: 2013 },
      tag: {
        artist: [{ tag: "k-pop", genre_mbid: "b74b3b6c-0700-46b1-aa55-1f2869a3bd1a" }],
        recording: [],
        release_group: []
      }
    },
    [RECORDING_C]: {
      artist: {
        name: "BTS",
        artists: [{ artist_mbid: BTS_MBID, name: "BTS" }]
      },
      recording: {
        name: "Spring Day",
        length: 274_000,
        first_release_date: "2017-02-13",
        isrcs: ["KRA381700060"]
      },
      release: { name: "You Never Walk Alone", year: 2017 },
      tag: {
        artist: [{ tag: "k-pop", genre_mbid: "b74b3b6c-0700-46b1-aa55-1f2869a3bd1a" }],
        recording: [{ tag: "melancholic" }],
        release_group: []
      }
    }
  };
}

describe("ListenBrainz service", () => {
  it("combines tag and artist radio, batch-enriches candidates, and uses only the fixed HTTPS API origin", async () => {
    const observedUrls: URL[] = [];
    const observedInits: RequestInit[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      observedUrls.push(url);
      observedInits.push(init);
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe("https://api.listenbrainz.org");
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("user-agent")).toContain("MoodTransit/2.0");
      expect(headers.get("accept")).toBe("application/json");

      if (url.pathname === "/1/lb-radio/tags") {
        expect(url.searchParams.getAll("tag")).toEqual(["k-pop"]);
        expect(url.searchParams.has("operator")).toBe(false);
        return jsonResponse([
          { recording_mbid: RECORDING_A, percent: 100, source: "artist", tag_count: 7 },
          { recording_mbid: RECORDING_B, percent: 92, source: "release-group", tag_count: 4 }
        ], { headers: { "x-ratelimit-limit": "30", "x-ratelimit-remaining": "29", "x-ratelimit-reset-in": "1" } });
      }
      if (url.pathname === `/1/lb-radio/artist/${TWICE_MBID}`) {
        expect(url.searchParams.get("mode")).toBe("easy");
        return jsonResponse({
          [TWICE_MBID]: [{
            recording_mbid: RECORDING_A,
            similar_artist_mbid: TWICE_MBID,
            similar_artist_name: "TWICE",
            total_listen_count: 9_011
          }],
          [BTS_MBID]: [{
            recording_mbid: RECORDING_C,
            similar_artist_mbid: BTS_MBID,
            similar_artist_name: "BTS",
            total_listen_count: 12_418
          }]
        });
      }
      if (url.pathname === "/1/metadata/recording/") {
        expect(init.method).toBe("POST");
        expect(headers.get("content-type")).toBe("application/json");
        const body = JSON.parse(init.body as string) as { recording_mbids: string[]; inc: string };
        expect(new Set(body.recording_mbids)).toEqual(new Set([RECORDING_A, RECORDING_B, RECORDING_C]));
        expect(body.inc).toBe("artist tag release");
        return jsonResponse(metadataFixture());
      }
      return new Response(null, { status: 404 });
    });

    const service = new ListenBrainzService({ fetchImpl: mockFetch });
    const result = await service.getCandidates({
      tags: [" K-Pop ", "k-pop"],
      seedArtistMbid: TWICE_MBID.toUpperCase(),
      artistMode: "easy",
      count: 3,
      popularityMin: 20
    });

    expect(result.source).toBe("listenbrainz-live");
    expect(result.attribution).toBe(LISTENBRAINZ_ATTRIBUTION);
    expect(result.candidates).toHaveLength(3);
    const twice = result.candidates.find((candidate) => candidate.recordingMbid === RECORDING_A);
    expect(twice).toMatchObject({
      id: `listenbrainz:${RECORDING_A}`,
      title: "SET ME FREE",
      artist: "TWICE",
      durationSec: 182,
      provider: "listenbrainz",
      providerUrl: `https://listenbrainz.org/track/${RECORDING_A}/`,
      recordingMbid: RECORDING_A,
      artistMbid: TWICE_MBID,
      isrc: "US5TA2300010",
      releaseTitle: "READY TO BE",
      releaseYear: 2023,
      popularity: 100
    });
    expect(twice?.tags).toEqual(expect.arrayContaining(["k-pop", "korean", "dance-pop", "ep"]));
    expect(twice?.genres).toEqual(expect.arrayContaining(["k-pop", "dance-pop"]));
    expect(result.candidates.find((candidate) => candidate.recordingMbid === RECORDING_C)).toMatchObject({
      title: "Spring Day",
      artist: "BTS",
      durationSec: 274,
      artistMbid: BTS_MBID
    });
    expect(result.candidates.find((candidate) => candidate.recordingMbid === RECORDING_B)?.language).toBe("ko");
    expect(observedUrls).toHaveLength(3);
    expect(observedInits.every((init) => init.redirect === "error")).toBe(true);
  });

  it("returns a successful empty result without making an unnecessary metadata request", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const service = new ListenBrainzService({ fetchImpl: mockFetch });
    await expect(service.getCandidates({ tags: ["tag-with-no-results"] })).resolves.toMatchObject({
      candidates: [],
      source: "listenbrainz-live"
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces equivalent in-flight requests and then serves a defensive copy from TTL cache", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockFetch = vi.fn<typeof fetch>(async () => {
      await gate;
      return jsonResponse([]);
    });
    const service = new ListenBrainzService({ fetchImpl: mockFetch });
    const first = service.getCandidates({ tags: [" K-POP ", "happy"], tagOperator: "OR" });
    const second = service.getCandidates({ tags: ["happy", "k-pop"], tagOperator: "OR" });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.source).toBe("listenbrainz-live");
    expect(secondResult.source).toBe("listenbrainz-live");

    const cached = await service.getCandidates({ tags: ["k-pop", "happy"] });
    expect(cached.source).toBe("listenbrainz-cache");
    expect(cached).not.toBe(firstResult);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("expires cache entries and evicts the least recently used key", async () => {
    let now = 1_000;
    const mockFetch = vi.fn<typeof fetch>(async () => jsonResponse([]));
    const service = new ListenBrainzService({
      fetchImpl: mockFetch,
      cacheTtlMs: 100,
      cacheMaxEntries: 2,
      now: () => now
    });

    await service.getCandidates({ tags: ["calm"] });
    await service.getCandidates({ tags: ["happy"] });
    expect((await service.getCandidates({ tags: ["calm"] })).source).toBe("listenbrainz-cache");
    await service.getCandidates({ tags: ["focused"] });
    expect((await service.getCandidates({ tags: ["happy"] })).source).toBe("listenbrainz-live");
    expect(mockFetch).toHaveBeenCalledTimes(4);

    now += 101;
    expect((await service.getCandidates({ tags: ["focused"] })).source).toBe("listenbrainz-live");
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("enforces one total deadline even when fetch waits for its abort signal", async () => {
    const hangingFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    }));
    const service = new ListenBrainzService({ fetchImpl: hangingFetch, deadlineMs: 30 });
    const started = performance.now();
    await expect(service.getCandidates({ tags: ["k-pop"] })).rejects.toMatchObject({
      name: "ListenBrainzServiceError",
      code: "DEADLINE_EXCEEDED",
      retryable: true
    });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("honors dynamic rate-limit headers before issuing another upstream request", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([], {
      headers: {
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-in": "10"
      }
    }));
    const service = new ListenBrainzService({ fetchImpl: mockFetch, deadlineMs: 50 });
    await service.getCandidates({ tags: ["calm"] });
    await expect(service.getCandidates({ tags: ["happy"] })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("waits for a short dynamic rate-limit reset when it fits inside the total deadline", async () => {
    const mockFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([], {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-in": "0.01" }
      }))
      .mockResolvedValueOnce(jsonResponse([], {
        headers: { "x-ratelimit-remaining": "29", "x-ratelimit-reset-in": "1" }
      }));
    const service = new ListenBrainzService({ fetchImpl: mockFetch, deadlineMs: 200 });
    await service.getCandidates({ tags: ["calm"] });
    const started = performance.now();
    await expect(service.getCandidates({ tags: ["happy"] })).resolves.toMatchObject({ candidates: [] });
    expect(performance.now() - started).toBeGreaterThanOrEqual(8);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a valid empty result from HTTP, redirect, and malformed-response failures", async () => {
    const httpService = new ListenBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }))
    });
    await expect(httpService.getCandidates({ tags: ["calm"] })).rejects.toMatchObject({
      code: "UPSTREAM_HTTP",
      status: 503
    });

    const malformedService = new ListenBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ items: [] }))
    });
    await expect(malformedService.getCandidates({ tags: ["calm"] })).rejects.toMatchObject({
      code: "INVALID_RESPONSE"
    });

    const redirected = jsonResponse([]);
    Object.defineProperty(redirected, "redirected", { value: true });
    const redirectService = new ListenBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(redirected)
    });
    await expect(redirectService.getCandidates({ tags: ["calm"] })).rejects.toMatchObject({
      code: "UPSTREAM_REDIRECT"
    });
  });

  it("rejects unbounded or invalid caller input before any network access", async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const service = new ListenBrainzService({ fetchImpl: mockFetch });
    const invalidInputs = [
      {},
      { tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`) },
      { tags: ["calm\nmalicious"] },
      { seedArtistMbid: "not-a-uuid" },
      { tags: ["calm"], popularityMin: 90, popularityMax: 10 },
      { tags: ["calm"], count: 51 }
    ];
    for (const input of invalidInputs) {
      await expect(service.getCandidates(input)).rejects.toBeInstanceOf(ListenBrainzServiceError);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
