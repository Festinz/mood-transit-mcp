import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { SERVER_NAME } from "../src/mcp/server.js";
import { ListenBrainzService } from "../src/services/listenbrainz.js";
import { MUSICBRAINZ_ATTRIBUTION, MusicBrainzService, type MusicBrainzCandidateQuery, type MusicBrainzCandidateResult } from "../src/services/musicbrainz.js";
import { WeatherService } from "../src/services/weather.js";

const weatherFetch = vi.fn<typeof fetch>()
  .mockResolvedValueOnce(new Response(JSON.stringify({ current: { temperature_2m: 25, apparent_temperature: 26, weather_code: 1, wind_speed_10m: 7, time: "2026-07-12T12:00" } }), { status: 200 }));
const liveIds = [
  "2007b5be-2a0f-47fc-8f9b-2965d0156bbb",
  "32d8536f-64f9-46e8-97e5-b7d401cd7e9a",
  "a7aec288-5aa5-472d-83fc-aa5315103b80"
] as const;
const listenBrainzFetch = vi.fn<typeof fetch>(async (input) => {
  const url = new URL(input.toString());
  if (url.pathname === "/1/lb-radio/tags") {
    return new Response(JSON.stringify(liveIds.map((recording_mbid, index) => ({ recording_mbid, percent: 100 - index * 10, tag_count: 4 }))));
  }
  if (url.pathname === "/1/metadata/recording/") {
    return new Response(JSON.stringify(Object.fromEntries(liveIds.map((id, index) => [id, {
      artist: { name: ["Test Mirror", "Test Bridge", "Test Arrive"][index], artists: [] },
      recording: { name: ["Rainy Start", "Gentle Turn", "Hopeful Landing"][index], length: 180_000 + index * 10_000, first_release_date: "2025-01-01", isrcs: [] },
      release: { name: "Live Test", year: 2025 },
      tag: { artist: [], recording: [{ tag: ["sad", "content", "hopeful"][index] }], release_group: [] }
    }]))));
  }
  return new Response(null, { status: 404 });
});

const RESCENE_MBID = "a54fd8e2-d319-44a6-aa60-21adf17751bf";
const TWICE_MBID = "22222222-3333-4444-8555-666666666666";
const stubArtists = {
  "리센느": {
    name: "RESCENE",
    mbid: RESCENE_MBID,
    titles: ["Pinball", "LOVE ATTACK", "Glow Up", "Counting Star", "In my lotion", "Love Echo"]
  },
  "TWICE": {
    name: "TWICE",
    mbid: TWICE_MBID,
    titles: ["Feel Special", "CHEER UP", "What Is Love?", "ONE SPARK", "Strategy", "Dance The Night Away"]
  }
} as const;

class StubMusicBrainzService extends MusicBrainzService {
  override async searchCandidates(input: MusicBrainzCandidateQuery): Promise<MusicBrainzCandidateResult> {
    if (input.trackTitles?.length && !input.artists?.length && !input.artistMbids?.length) {
      return {
        candidates: ["Artist One", "Artist Two", "Artist Three"].map((artist, index) => ({
          id: `musicbrainz:ambiguous-${index}`,
          title: input.trackTitles![0]!,
          artist,
          durationSec: 180,
          provider: "musicbrainz" as const,
          recordingMbid: `10000000-0000-4000-8000-00000000000${index}`
        })),
        matchedArtists: [],
        matchedArtistNames: [],
        matchedArtistMbids: [],
        source: "musicbrainz-live",
        attribution: MUSICBRAINZ_ATTRIBUTION,
        fetchedAt: "2026-07-13T00:00:00.000Z"
      };
    }
    const requestedArtists = (input.artists ?? []).flatMap((requestedName) => {
      const fixture = stubArtists[requestedName as keyof typeof stubArtists];
      return fixture ? [{ requestedName, fixture }] : [];
    });
    const mbidArtists = (input.artistMbids ?? []).flatMap((mbid) => (
      Object.entries(stubArtists)
        .filter(([, fixture]) => fixture.mbid === mbid)
        .map(([requestedName, fixture]) => ({ requestedName, fixture }))
    ));
    const resolvedArtists = requestedArtists.length > 0 ? requestedArtists : mbidArtists;
    // A combined MusicBrainz OR query can fill its limit from the first artist. The production
    // implementation must issue bounded per-artist searches, which this stub makes observable.
    const catalogArtists = (input.artists?.length ?? 0) > 1 ? resolvedArtists.slice(0, 1) : resolvedArtists;
    const requestedTitles = new Set(input.trackTitles ?? []);
    const candidates = catalogArtists.flatMap(({ fixture }, artistIndex) => fixture.titles
      .filter((title) => requestedTitles.size === 0 || requestedTitles.has(title))
      .map((title, index) => {
        const recordingMbid = `${artistIndex + (fixture.name === "TWICE" ? 2 : 1)}0000000-0000-4000-8000-00000000000${index}`;
        return {
          id: `musicbrainz:${fixture.name.toLowerCase()}-${index}`,
          title,
          artist: fixture.name,
          durationSec: 170 + index * 4,
          provider: "musicbrainz" as const,
          providerUrl: `https://musicbrainz.org/recording/${recordingMbid}`,
          recordingMbid,
          artistMbid: fixture.mbid,
          artistMbids: [fixture.mbid],
          tags: [index < 2 ? "sad" : index < 4 ? "content" : "joyful", "k-pop"]
        };
      }))
      .slice(0, input.count ?? 24);
    return {
      candidates,
      matchedArtists: requestedArtists.map(({ requestedName, fixture }) => ({
        requestedName,
        name: fixture.name,
        mbid: fixture.mbid,
        matchedBy: requestedName === "리센느" ? "alias" as const : "name" as const,
        ...(requestedName === "리센느" ? { matchedAlias: "리센느" } : {})
      })),
      matchedArtistNames: requestedArtists.map(({ fixture }) => fixture.name),
      matchedArtistMbids: resolvedArtists.map(({ fixture }) => fixture.mbid),
      source: "musicbrainz-live",
      attribution: MUSICBRAINZ_ATTRIBUTION,
      fetchedAt: "2026-07-13T00:00:00.000Z"
    };
  }
}
const app = createApp({
  weatherService: new WeatherService({ fetchImpl: weatherFetch }),
  listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch }),
  musicBrainzService: new StubMusicBrainzService()
});
let server: HttpServer;
let endpoint: URL;

beforeAll(async () => {
  server = await new Promise<HttpServer>((resolve) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const address = server.address() as AddressInfo;
  endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("HTTP service", () => {
  it("serves root, liveness, and readiness on deployment-friendly paths", async () => {
    await request(app).get("/").expect(200).expect(({ body }) => expect(body.mcpEndpoint).toBe("/mcp"));
    await request(app).get("/healthz").expect(200).expect(({ body }) => expect(body.status).toBe("ok"));
    await request(app).get("/readyz").expect(200).expect(({ body }) => expect(body.status).toBe("ready"));
  });

  it("rejects non-POST MCP methods and oversized JSON", async () => {
    await request(app).get("/mcp").expect(405).expect("Allow", "POST");
    await request(app).post("/mcp").set("content-type", "application/json").send({ value: "x".repeat(70_000) }).expect(413);
  });

  it("rejects invalid browser origins while allowing absent and configured origins", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "origin-test", version: "1.0.0" } }
    };
    const invalid = await request(app)
      .post("/mcp")
      .set("origin", "https://attacker.example")
      .set("accept", "application/json, text/event-stream")
      .set("content-type", "application/json")
      .send(initialize)
      .expect(403);
    expect(invalid.body).toEqual(expect.objectContaining({
      jsonrpc: "2.0",
      error: expect.objectContaining({ message: "Forbidden: invalid Origin header" }),
      id: null
    }));

    const trustedApp = createApp({ allowedOrigins: ["https://trusted.example"] });
    await request(trustedApp)
      .post("/mcp")
      .set("origin", "https://trusted.example")
      .set("accept", "application/json, text/event-stream")
      .set("content-type", "application/json")
      .send(initialize)
      .expect(200);
  });

  it.each(["2025-03-26", "2025-11-25"])("initializes protocol %s", async (protocolVersion) => {
    const response = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("content-type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "protocol-test", version: "1.0.0" } } })
      .expect(200);
    expect(response.body.result.protocolVersion).toBe(protocolVersion);
    expect(response.body.result.serverInfo.name).toBe(SERVER_NAME);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });
});

describe("MCP SDK discovery and representative calls", () => {
  it("lists exactly three fully annotated tools and calls each one", async () => {
    const client = new Client({ name: "vitest-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(3);
      expect(list.tools.map((tool) => tool.name).sort()).toEqual(["arrange_candidate_mood_journey", "build_live_mood_journey", "refine_mood_journey"]);
      expect(SERVER_NAME.toLowerCase()).not.toContain("kakao");
      for (const tool of list.tools) {
        expect(tool.name.toLowerCase()).not.toContain("kakao");
        expect(tool.title).toBeTruthy();
        expect(tool.description).toContain("MoodTransit(기분환승)");
        expect(tool.description?.length).toBeLessThanOrEqual(1_024);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.annotations).toEqual(expect.objectContaining({
          title: expect.any(String),
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: tool.name !== "arrange_candidate_mood_journey"
        }));
      }

      const live = await client.callTool({ name: "build_live_mood_journey", arguments: { currentMood: "울적", targetMood: "hopeful", weather: "rain", activity: "commute", minutes: 20, preferences: { preferredGenres: ["k-pop"], discovery: "adventurous" } } });
      expect(live.isError).not.toBe(true);
      expect(live.structuredContent).toHaveProperty("selectionScope.kind", "public_open_catalog");

      const artistLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "기분이 안좋은데",
          targetMood: "행복",
          minutes: 20,
          preferences: { preferredArtists: ["리센느"], artistScope: "only" }
        }
      });
      expect(artistLive.isError).not.toBe(true);
      expect(artistLive.structuredContent).toHaveProperty("selectionScope.kind", "public_open_catalog");
      expect(artistLive.structuredContent).toHaveProperty("searchResolution", expect.objectContaining({
        requestedArtists: ["리센느"],
        requestedTracks: [],
        matchedArtists: ["RESCENE"],
        matchedTracks: []
      }));
      const artistTracks = (artistLive.structuredContent?.stages as Array<{ tracks: Array<{ artist: string }> }>).flatMap((stage) => stage.tracks);
      expect(artistTracks.length).toBeGreaterThanOrEqual(3);
      expect(artistTracks.every((track) => track.artist === "RESCENE")).toBe(true);

      const modelWordedArtistLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "기분이 안좋음",
          targetMood: "좋음",
          minutes: 30,
          preferences: { preferredArtists: ["리센느"], artistScope: "only" }
        }
      });
      expect(modelWordedArtistLive.isError).not.toBe(true);
      expect(modelWordedArtistLive.structuredContent).toHaveProperty("searchResolution", expect.objectContaining({
        requestedArtists: ["리센느"],
        matchedArtists: ["RESCENE"]
      }));

      const multiArtistLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "기분이 안 좋은데",
          targetMood: "행복",
          minutes: 20,
          preferences: { preferredArtists: ["리센느", "TWICE"], artistScope: "only" }
        }
      });
      expect(multiArtistLive.isError).not.toBe(true);
      expect(multiArtistLive.structuredContent).toHaveProperty("searchResolution", expect.objectContaining({
        requestedArtists: ["리센느", "TWICE"],
        matchedArtists: expect.arrayContaining(["RESCENE", "TWICE"]),
        artistSearchStatus: "ok"
      }));
      const multiArtistTracks = (multiArtistLive.structuredContent?.stages as Array<{ tracks: Array<{ artist: string }> }>)
        .flatMap((stage) => stage.tracks);
      expect(new Set(multiArtistTracks.map((track) => track.artist))).toEqual(new Set(["RESCENE", "TWICE"]));

      const ambiguousTrack = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "우울",
          targetMood: "행복",
          minutes: 20,
          preferences: { preferredTracks: ["LOVE ATTACK"] }
        }
      });
      expect(ambiguousTrack.isError).toBe(true);
      expect(ambiguousTrack.structuredContent).toHaveProperty("error.code", "TRACK_AMBIGUOUS");

      const liveState = live.structuredContent?.refinementState as Record<string, unknown>;
      const liveRefined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: { ...liveState, candidateSource: {} },
          changes: { moodDirection: "brighter" }
        }
      });
      expect(liveRefined.isError).not.toBe(true);
      expect(liveRefined.structuredContent).toHaveProperty("revision", 1);

      const cityLive = await client.callTool({ name: "build_live_mood_journey", arguments: { currentMood: "울적", targetMood: "hopeful", city: "Seoul", activity: "commute", minutes: 20, preferences: { preferredGenres: ["k-pop"], discovery: "adventurous" } } });
      expect(cityLive.isError).not.toBe(true);
      expect((cityLive.content[0] as { text: string }).text).toContain("Open-Meteo");
      expect(cityLive.structuredContent).toHaveProperty("sources", expect.arrayContaining([expect.objectContaining({ name: "Open-Meteo", license: "CC BY 4.0" })]));

      const arranged = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: {
          currentMood: "sad",
          targetMood: "hopeful",
          minutes: 20,
          candidateSource: { providerName: "Melon MCP", toolName: "recommend_personalized_songs_by_dj_mallang" },
          candidates: Array.from({ length: 7 }, (_, index) => ({
            providerTrackId: `melon-${index + 1}`,
            title: `Candidate ${index + 1}`,
            artist: `Artist ${index + 1}`,
            durationSec: 180 + index * 5,
            originalRank: index + 1,
            moodTags: index < 2 ? ["sad"] : index < 5 ? ["content"] : ["hopeful"]
          }))
        }
      });
      expect(arranged.isError).not.toBe(true);
      expect(arranged.structuredContent).toHaveProperty("selectionScope.kind", "provided_candidate_batch");
      expect(Buffer.byteLength(JSON.stringify(arranged), "utf8")).toBeLessThan(25_000);
      const refinementState = arranged.structuredContent?.refinementState;
      expect(refinementState).toBeTruthy();
      expect(refinementState).toHaveProperty("candidatePoolToken");
      expect(refinementState).not.toHaveProperty("candidatePool");

      const refined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState,
          changes: { discoveryDirection: "more_discovery", excludeTrackIds: ["melon-1"] }
        }
      });
      expect(refined.isError).not.toBe(true);
      expect((refined.content[0] as { text: string }).text).toContain("Mirror");
      expect(refined.structuredContent).toHaveProperty("revision", 1);
    } finally {
      await client.close();
    }
  });

  it("returns bounded schema errors for invalid input", async () => {
    const client = new Client({ name: "invalid-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const result = await client.callTool({ name: "build_live_mood_journey", arguments: { currentMood: "sad", targetMood: "calm", minutes: 2 } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(5_000);
    } finally {
      await client.close();
    }
  });

  it("rejects literal non-public provider URLs while allowing a public HTTPS literal", async () => {
    const client = new Client({ name: "provider-url-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const argumentsFor = (providerUrl: string) => ({
      currentMood: "sad",
      targetMood: "hopeful",
      minutes: 20,
      candidateSource: { providerName: "Supplied provider" },
      candidates: Array.from({ length: 3 }, (_, index) => ({
        providerTrackId: `url-${index}`,
        title: `URL Candidate ${index}`,
        artist: `URL Artist ${index}`,
        durationSec: 180,
        providerUrl,
        moodTags: [index === 0 ? "sad" : index === 1 ? "content" : "hopeful"]
      }))
    });
    try {
      const rejected = [
        "http://example.com/track",
        "https://localhost./track",
        "https://127.1/track",
        "https://0.1.2.3/track",
        "https://10.1.2.3/track",
        "https://172.16.0.1/track",
        "https://192.168.1.1/track",
        "https://169.254.1.1/track",
        "https://[::1]/track",
        "https://[fe80::1]/track",
        "https://[fc00::1]/track",
        "https://[::ffff:127.0.0.1]/track"
      ];
      for (const providerUrl of rejected) {
        const result = await client.callTool({
          name: "arrange_candidate_mood_journey",
          arguments: argumentsFor(providerUrl)
        });
        expect(result.isError, providerUrl).toBe(true);
      }

      const publicResult = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: argumentsFor("https://8.8.8.8/track")
      });
      expect(publicResult.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it("does not start ListenBrainz discovery for an explicit artist-only request", async () => {
    const listenBrainzService = new ListenBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("ListenBrainz must not be called"))
    });
    const getCandidates = vi.spyOn(listenBrainzService, "getCandidates");
    const isolatedApp = createApp({
      listenBrainzService,
      musicBrainzService: new StubMusicBrainzService()
    });
    const isolatedServer = await new Promise<HttpServer>((resolve) => {
      const candidate = isolatedApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = isolatedServer.address() as AddressInfo;
    const client = new Client({ name: "artist-only-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "기분이 안좋은데",
          targetMood: "행복",
          minutes: 20,
          preferences: { preferredArtists: ["리센느"], artistScope: "only" }
        }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("selectionScope.kind", "public_open_catalog");
      expect(getCandidates).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => isolatedServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("sanitizes unexpected tool exceptions as INTERNAL_ERROR", async () => {
    class ThrowingWeatherService extends WeatherService {
      override async lookup(_city: string): Promise<never> {
        throw new Error("sensitive-internal-detail");
      }
    }
    const isolatedApp = createApp({
      weatherService: new ThrowingWeatherService(),
      listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch }),
      musicBrainzService: new StubMusicBrainzService()
    });
    const isolatedServer = await new Promise<HttpServer>((resolve) => {
      const candidate = isolatedApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = isolatedServer.address() as AddressInfo;
    const client = new Client({ name: "internal-error-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { currentMood: "sad", targetMood: "hopeful", minutes: 20, city: "Seoul" }
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty("error.code", "INTERNAL_ERROR");
      expect(JSON.stringify(result)).not.toContain("sensitive-internal-detail");
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => isolatedServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps boundary-sized provider results below 64 KiB and safely renders supplied links", async () => {
    const client = new Client({ name: "boundary-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const arranged = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: {
          currentMood: "sad",
          targetMood: "hopeful",
          minutes: 60,
          candidateSource: { providerName: "Melon MCP" },
          candidates: Array.from({ length: 20 }, (_, index) => ({
            providerTrackId: `boundary-${index}-${"식".repeat(100)}`,
            title: `${"긴제목".repeat(29)}-${index}`,
            artist: `${"긴아티스트".repeat(19)}-${index}`,
            album: "긴앨범".repeat(30),
            durationSec: 180,
            providerUrl: index === 0
              ? "https://evil.example/foo) [x](javascript:alert(1)"
              : `https://music.example/${"p".repeat(300)}-${index}`,
            originalRank: index + 1,
            genres: ["genre".repeat(8), "another-genre"],
            moodTags: [index < 6 ? "sad" : index < 13 ? "content" : "hopeful"]
          }))
        }
      });
      expect(arranged.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(arranged), "utf8")).toBeLessThanOrEqual(64 * 1_024);
      const markdown = (arranged.content[0] as { text: string }).text;
      expect(markdown).toContain("evil\\.example");
      expect(markdown).not.toContain("](javascript:");
      expect(markdown).not.toContain("[x](javascript:");
    } finally {
      await client.close();
    }
  });

  it("keeps returned refinement state valid across limits and rejects corrupted tokens", async () => {
    const client = new Client({ name: "state-invariant-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const arranged = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: {
          currentMood: "sad",
          targetMood: "hopeful",
          minutes: 20,
          preferences: { avoidArtists: Array.from({ length: 12 }, (_, index) => `Old Avoid ${index}`) },
          candidateSource: { providerName: "Authorized provider" },
          candidates: Array.from({ length: 8 }, (_, index) => ({
            providerTrackId: `state-${index}`,
            title: `State Candidate ${index}`,
            artist: `Safe Artist ${index}`,
            durationSec: 180,
            moodTags: [index < 3 ? "sad" : index < 6 ? "content" : "hopeful"]
          }))
        }
      });
      expect(arranged.isError).not.toBe(true);
      const state = arranged.structuredContent?.refinementState as Record<string, unknown>;
      const first = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: state,
          changes: { avoidArtists: Array.from({ length: 12 }, (_, index) => `New Avoid ${index}`) }
        }
      });
      expect(first.isError).not.toBe(true);
      const firstState = first.structuredContent?.refinementState as { request: { tasteProfile: { avoidArtists: string[] } } };
      expect(firstState.request.tasteProfile.avoidArtists).toHaveLength(12);
      const second = await client.callTool({
        name: "refine_mood_journey",
        arguments: { refinementState: first.structuredContent?.refinementState, changes: { discoveryDirection: "more_discovery" } }
      });
      expect(second.isError).not.toBe(true);

      const terminal = await client.callTool({
        name: "refine_mood_journey",
        arguments: { refinementState: { ...state, revision: 50 }, changes: { moodDirection: "brighter" } }
      });
      expect(terminal.isError).toBe(true);
      expect(terminal.structuredContent).toHaveProperty("error.code", "REVISION_LIMIT_REACHED");

      const token = String(state.candidatePoolToken);
      const corrupted = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      const invalid = await client.callTool({
        name: "refine_mood_journey",
        arguments: { refinementState: { ...state, candidatePoolToken: corrupted }, changes: { moodDirection: "brighter" } }
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toHaveProperty("error.code", "INVALID_REFINEMENT_STATE");
    } finally {
      await client.close();
    }
  });

  it("returns a bounded actionable error for incompressible candidate metadata", async () => {
    const noisy = (seed: string, length: number) => {
      let output = "";
      let counter = 0;
      while (output.length < length) {
        output += createHash("sha256").update(`${seed}:${counter}`).digest("base64url");
        counter += 1;
      }
      return output.slice(0, length);
    };
    const client = new Client({ name: "metadata-limit-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const result = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: {
          currentMood: "sad",
          targetMood: "hopeful",
          minutes: 60,
          candidateSource: { providerName: "Large provider" },
          candidates: Array.from({ length: 20 }, (_, index) => ({
            providerTrackId: noisy(`id-${index}`, 128),
            title: noisy(`title-${index}`, 120),
            artist: noisy(`artist-${index}`, 100),
            album: noisy(`album-${index}`, 120),
            durationSec: 180,
            providerUrl: `https://example.com/${noisy(`url-${index}`, 360)}`,
            genres: Array.from({ length: 6 }, (_, tag) => noisy(`genre-${index}-${tag}`, 40)),
            moodTags: [index < 6 ? "sad" : index < 13 ? "content" : "hopeful", ...Array.from({ length: 5 }, (_, tag) => noisy(`mood-${index}-${tag}`, 40))]
          }))
        }
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty("error.code", "CANDIDATE_METADATA_TOO_LARGE");
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(2_000);
    } finally {
      await client.close();
    }
  });

  it("labels the 67-track emergency path as fallback rather than a provider batch", async () => {
    const failedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const fallbackApp = createApp({ listenBrainzService: new ListenBrainzService({ fetchImpl: failedFetch }) });
    const fallbackServer = await new Promise<HttpServer>((resolve) => {
      const candidate = fallbackApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = fallbackServer.address() as AddressInfo;
    const client = new Client({ name: "fallback-label-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { currentMood: "sad", targetMood: "hopeful", minutes: 20 }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("selectionScope.kind", "curated_fallback");
      const limitations = result.structuredContent?.limitations as string[];
      expect(limitations).toEqual(expect.arrayContaining([expect.stringContaining("비상 후보")]));
      expect(limitations.join(" ")).not.toContain("전달받은 후보 묶음");
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => fallbackServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
