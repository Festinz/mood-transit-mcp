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
const FALL_OUT_BOY_MBID = "516cef4d-0718-4007-9939-f9b38af3f784";
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
  },
  "fall out boy": {
    name: "Fall Out Boy",
    mbid: FALL_OUT_BOY_MBID,
    titles: ["Sugar, We're Goin Down", "Dance, Dance", "Thnks fr th Mmrs", "Centuries", "Uma Thurman", "My Songs Know What You Did in the Dark"]
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

class TagMusicBrainzService extends StubMusicBrainzService {
  readonly tagQueries: MusicBrainzCandidateQuery[] = [];

  override async searchCandidates(input: MusicBrainzCandidateQuery): Promise<MusicBrainzCandidateResult> {
    if (input.tags?.length) {
      this.tagQueries.push(input);
      return {
        candidates: ["content", "joyful", "energetic"].map((mood, index) => ({
          id: `musicbrainz:tag-fallback-${index}`,
          title: `Refreshing ${index + 1}`,
          artist: `Tag Artist ${index + 1}`,
          durationSec: 180,
          provider: "musicbrainz" as const,
          tags: [mood, index === 1 ? "upbeat" : "refreshing"]
        })),
        matchedArtists: [],
        matchedArtistNames: [],
        matchedArtistMbids: [],
        source: "musicbrainz-live",
        attribution: MUSICBRAINZ_ATTRIBUTION,
        fetchedAt: "2026-07-13T00:00:00.000Z"
      };
    }
    return super.searchCandidates(input);
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

    const playMcp = await request(app)
      .post("/mcp")
      .set("origin", "https://playmcp.kakao.com")
      .set("accept", "application/json, text/event-stream")
      .set("content-type", "application/json")
      .send(initialize)
      .expect(200);
    expect(playMcp.headers["access-control-allow-origin"]).toBe("https://playmcp.kakao.com");
    expect(playMcp.headers.vary).toContain("Origin");

    await request(app)
      .options("/mcp")
      .set("origin", "https://playmcp.kakaocloud.io")
      .set("access-control-request-method", "POST")
      .expect(204)
      .expect("Access-Control-Allow-Origin", "https://playmcp.kakaocloud.io");

    for (const origin of ["https://evil.playmcp.kakao.com", "null"]) {
      await request(app)
        .post("/mcp")
        .set("origin", origin)
        .set("accept", "application/json, text/event-stream")
        .set("content-type", "application/json")
        .send(initialize)
        .expect(403);
    }

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
      const buildTool = list.tools.find((tool) => tool.name === "build_live_mood_journey");
      const buildProperties = (buildTool?.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(buildProperties).toEqual(expect.objectContaining({
        requestText: expect.any(Object),
        semanticIntent: expect.any(Object)
      }));
      const buildRequired = (buildTool?.inputSchema as { required?: string[] }).required ?? [];
      expect(buildRequired).not.toContain("semanticIntent");
      expect(buildRequired).not.toContain("minutes");
      expect(buildTool?.description).toContain("Copy the complete utterance");
      const buildSchemaText = JSON.stringify(buildTool?.inputSchema);
      expect(buildSchemaText).toContain("[hH][uU][nN][tT][eE][rR]");
      expect(buildSchemaText).toContain("{0,4}");
      expect(buildSchemaText).toContain("[aA][kK][iI][aA]");

      const live = await client.callTool({ name: "build_live_mood_journey", arguments: { currentMood: "울적", targetMood: "hopeful", weather: "rain", activity: "commute", minutes: 20, preferences: { preferredGenres: ["k-pop"], discovery: "adventurous" } } });
      expect(live.isError).not.toBe(true);
      expect(live.structuredContent).toHaveProperty("selectionScope.kind", "public_open_catalog");

      const hotWeatherLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { currentMood: "더운", targetMood: "시원한", minutes: 30 }
      });
      expect(hotWeatherLive.isError).not.toBe(true);
      expect(hotWeatherLive.structuredContent).toHaveProperty("currentMood", "content");
      expect(hotWeatherLive.structuredContent).toHaveProperty("targetMood", "energetic");
      expect(hotWeatherLive.structuredContent).toHaveProperty("context", expect.objectContaining({
        weather: "더운",
        desiredVibe: "시원한",
        contextTags: expect.arrayContaining(["summer", "refreshing", "upbeat"]),
        contextMatchMode: "broadened"
      }));

      const screenshotRequest = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "우울",
          targetMood: "시원한",
          weather: "더운 날씨",
          minutes: 30
        }
      });
      expect(screenshotRequest.isError).not.toBe(true);
      expect(screenshotRequest.structuredContent).toHaveProperty("currentMood", "sad");
      expect(screenshotRequest.structuredContent).toHaveProperty("targetMood", "energetic");
      expect(screenshotRequest.structuredContent).toHaveProperty("context", expect.objectContaining({
        weather: "더운 날씨",
        desiredVibe: "시원한",
        contextTags: expect.arrayContaining(["summer", "refreshing"])
      }));

      const vibeOnlyLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { weather: "오늘은 폭염", desiredVibe: "청량하고 상쾌한", minutes: 30 }
      });
      expect(vibeOnlyLive.isError).not.toBe(true);
      expect(vibeOnlyLive.structuredContent).toHaveProperty("currentMood", "content");
      expect(vibeOnlyLive.structuredContent).toHaveProperty("targetMood", "energetic");
      expect(vibeOnlyLive.structuredContent).toHaveProperty("context.desiredVibe", "청량하고 상쾌한");

      const semanticCallStart = listenBrainzFetch.mock.calls.length;
      const freeRequestText = "이름 붙이기 어려운 축축한 네온빛 새벽에서 머릿속 매듭이 풀리듯 빠져나가고 싶어";
      const semanticLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: freeRequestText,
          currentMood: freeRequestText,
          desiredVibe: freeRequestText,
          semanticIntent: {
            current: { label: "축축한 네온빛 새벽", valence: 0.12, energy: 0.25, acousticness: 0.78 },
            target: { label: "숨통이 트이는 맑은 상태", valence: 0.78, energy: 0.58, acousticness: 0.48 },
            discoveryTags: ["ethereal", "night drive", "dream pop"],
            excludeTags: ["metal"]
          },
          activity: "창문을 반쯤 열고 해안도로를 천천히 도는 중",
          minutes: 30
        }
      });
      expect(semanticLive.isError).not.toBe(true);
      expect(semanticLive.structuredContent).toHaveProperty("currentMood", "sad");
      expect(semanticLive.structuredContent).toHaveProperty("targetMood", "hopeful");
      expect(semanticLive.structuredContent).toHaveProperty("interpretation", expect.objectContaining({
        semanticSource: "host_supplied",
        semanticCoverage: "full",
        discoveryTags: ["ethereal", "night drive", "dream pop"],
        excludeTags: ["metal"]
      }));
      expect(semanticLive.structuredContent).toHaveProperty("refinementState", expect.objectContaining({
        stateVersion: "2",
        request: expect.objectContaining({
          requestText: freeRequestText,
          semanticIntent: expect.objectContaining({
            current: expect.objectContaining({ valence: 0.12, energy: 0.25, acousticness: 0.78 }),
            target: expect.objectContaining({ valence: 0.78, energy: 0.58, acousticness: 0.48 }),
            discoveryTags: ["ethereal", "night drive", "dream pop"],
            excludeTags: ["metal"]
          })
        })
      }));
      const semanticRadioCalls = listenBrainzFetch.mock.calls.slice(semanticCallStart)
        .map(([input]) => new URL(input instanceof Request ? input.url : input.toString()))
        .filter((url) => url.pathname === "/1/lb-radio/tags");
      expect(semanticRadioCalls.length).toBeGreaterThan(0);
      const semanticQueryTags = semanticRadioCalls.flatMap((url) => url.searchParams.getAll("tag"));
      expect(semanticQueryTags).toEqual(expect.arrayContaining(["ethereal", "night drive", "dream pop", "sad", "hopeful"]));
      expect(semanticQueryTags).not.toContain(freeRequestText.toLocaleLowerCase("en"));
      expect(semanticQueryTags).not.toContain("창문을 반쯤 열고 해안도로를 천천히 도는 중");

      const legacyRawCallStart = listenBrainzFetch.mock.calls.length;
      const legacyRaw = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "angry",
          targetMood: "romantic",
          activity: "password hunter2",
          minutes: 20
        }
      });
      expect(legacyRaw.isError).not.toBe(true);
      const legacyRawQueries = listenBrainzFetch.mock.calls.slice(legacyRawCallStart)
        .map(([input]) => new URL(input instanceof Request ? input.url : input.toString()))
        .filter((url) => url.pathname === "/1/lb-radio/tags");
      expect(legacyRawQueries.length).toBeGreaterThan(0);
      expect(legacyRawQueries.flatMap((url) => url.searchParams.getAll("tag"))).not.toContain("password hunter2");

      const semanticRefined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: semanticLive.structuredContent?.refinementState,
          changes: {
            requestText: "이제는 포근하되 처지지는 않게 바꿔줘",
            targetSemantic: { label: "포근하지만 또렷한 상태", valence: 0.68, energy: 0.38, acousticness: 0.82 },
            discoveryTags: ["cozy", "warm acoustic"],
            excludeTags: []
          }
        }
      });
      expect(semanticRefined.isError).not.toBe(true);
      expect(semanticRefined.structuredContent).toHaveProperty("refinementState", expect.objectContaining({
        stateVersion: "2",
        request: expect.objectContaining({
          requestText: "이제는 포근하되 처지지는 않게 바꿔줘",
          semanticIntent: expect.objectContaining({
            current: expect.objectContaining({ label: "축축한 네온빛 새벽" }),
            target: expect.objectContaining({ label: "포근하지만 또렷한 상태" }),
            discoveryTags: ["cozy", "warm acoustic"],
            excludeTags: []
          })
        })
      }));

      const semanticDirectionalRefined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: semanticLive.structuredContent?.refinementState,
          changes: {
            requestText: "조금 더 밝고 에너지 있게 바꿔줘",
            moodDirection: "brighter",
            energyDirection: "more_energy"
          }
        }
      });
      expect(semanticDirectionalRefined.isError).not.toBe(true);
      expect(semanticDirectionalRefined.structuredContent).toHaveProperty(
        "refinementState.request.semanticIntent.target",
        { valence: 1, energy: 0.83, acousticness: 0.48 }
      );
      expect(semanticDirectionalRefined.structuredContent).toHaveProperty("interpretation.targetAxes", {
        valence: 1,
        energy: 0.83,
        acousticness: 0.48
      });
      expect(semanticDirectionalRefined.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(semanticDirectionalRefined.structuredContent).toHaveProperty("refinementState.request.targetMood", "joyful");

      const vibeRefined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: hotWeatherLive.structuredContent?.refinementState,
          changes: { targetMood: "포근하고 아늑하게" }
        }
      });
      expect(vibeRefined.isError).not.toBe(true);
      expect(vibeRefined.structuredContent).toHaveProperty("targetMood", "calm");
      expect(vibeRefined.structuredContent).toHaveProperty("refinementState.request.desiredVibe", "포근하고 아늑하게");
      expect(vibeRefined.structuredContent).toHaveProperty("refinementState.request.contextTags", expect.arrayContaining(["cozy", "acoustic"]));
      const refinedContextTags = (vibeRefined.structuredContent?.refinementState as { request: { contextTags: string[] } }).request.contextTags;
      expect(refinedContextTags).not.toContain("refreshing");
      expect(refinedContextTags).not.toContain("upbeat");

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

      const fallOutBoyLive = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "오늘 기분이 좋아 fall out boy 노래중 재밌는 거 추천해줘",
          preferences: { preferredArtists: ["fall out boy"], artistScope: "only" }
        }
      });
      expect(fallOutBoyLive.isError).not.toBe(true);
      expect(fallOutBoyLive.structuredContent).toHaveProperty("requestedMinutes", 30);
      expect(fallOutBoyLive.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");
      expect(fallOutBoyLive.structuredContent).toHaveProperty("searchResolution", expect.objectContaining({
        requestedArtists: ["fall out boy"],
        matchedArtists: ["Fall Out Boy"]
      }));
      const fallOutBoyTracks = (fallOutBoyLive.structuredContent?.stages as Array<{ tracks: Array<{ artist: string }> }>)
        .flatMap((stage) => stage.tracks);
      expect(fallOutBoyTracks.length).toBeGreaterThanOrEqual(3);
      expect(fallOutBoyTracks.every((track) => track.artist === "Fall Out Boy")).toBe(true);

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
      const legacyRequest = liveState.request as Record<string, unknown>;
      const legacyTaste = (legacyRequest.tasteProfile ?? {}) as Record<string, unknown>;
      const liveRefined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: {
            ...liveState,
            stateVersion: "1",
            candidateSource: {},
            request: {
              ...legacyRequest,
              contextTags: ["Summer Vibes"],
              tasteProfile: {
                ...legacyTaste,
                favoriteGenres: ["K-Pop"],
                avoidGenres: ["R&B"]
              }
            }
          },
          changes: { moodDirection: "brighter" }
        }
      });
      expect(liveRefined.isError).not.toBe(true);
      expect(liveRefined.structuredContent).toHaveProperty("revision", 1);
      expect(liveRefined.structuredContent).toHaveProperty("refinementState.stateVersion", "2");
      expect(liveRefined.structuredContent).toHaveProperty("refinementState.request.tasteProfile.favoriteGenres", ["K-Pop"]);

      const weatherAwareCallStart = listenBrainzFetch.mock.calls.length;
      const cityLive = await client.callTool({ name: "build_live_mood_journey", arguments: { currentMood: "울적", targetMood: "hopeful", city: "Seoul", activity: "commute", minutes: 20, preferences: { preferredGenres: ["k-pop"], discovery: "adventurous" } } });
      expect(cityLive.isError).not.toBe(true);
      expect((cityLive.content[0] as { text: string }).text).toContain("Open-Meteo");
      expect(cityLive.structuredContent).toHaveProperty("sources", expect.arrayContaining([expect.objectContaining({ name: "Open-Meteo", license: "CC BY 4.0" })]));
      const cityRadioCalls = listenBrainzFetch.mock.calls.slice(weatherAwareCallStart)
        .map(([input]) => new URL(input instanceof Request ? input.url : input.toString()))
        .filter((url) => url.pathname === "/1/lb-radio/tags");
      expect(cityRadioCalls.some((url) => url.searchParams.getAll("tag").includes("dreamy"))).toBe(true);

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

      const arrangedWithoutSemanticIntent = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: {
          requestText: "비 오는 퇴근길에 기분을 조금 밝게 바꿔줘",
          candidateSource: { providerName: "Melon MCP" },
          candidates: Array.from({ length: 7 }, (_, index) => ({
            providerTrackId: `fallback-${index + 1}`,
            title: `Fallback Candidate ${index + 1}`,
            artist: `Fallback Artist ${index + 1}`,
            durationSec: 180,
            moodTags: index < 3 ? ["sad"] : ["hopeful"]
          }))
        }
      });
      expect(arrangedWithoutSemanticIntent.isError).not.toBe(true);
      expect(arrangedWithoutSemanticIntent.structuredContent).toHaveProperty("requestedMinutes", 30);
      expect(arrangedWithoutSemanticIntent.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");

      const refinedWithoutSemanticIntent = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: arrangedWithoutSemanticIntent.structuredContent?.refinementState,
          changes: { requestText: "첫 곡은 빼고 조금 더 밝게 바꿔줘", excludeTrackIds: ["fallback-1"] }
        }
      });
      expect(refinedWithoutSemanticIntent.isError).not.toBe(true);
      expect(refinedWithoutSemanticIntent.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");

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

      const invalidAxes = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "범위를 벗어난 의미 좌표",
          semanticIntent: {
            target: { valence: 1.1, energy: 0.5, acousticness: 0.5 },
            discoveryTags: ["calm"]
          },
          minutes: 20
        }
      });
      expect(invalidAxes.isError).toBe(true);

      const fallbackCallStart = listenBrainzFetch.mock.calls.length;
      const missingSemanticIntent = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "분노와 허탈함이 섞였는데 차갑고 단단하게 집중하고 싶어", minutes: 20 }
      });
      expect(missingSemanticIntent.isError).not.toBe(true);
      expect(missingSemanticIntent.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");
      expect(missingSemanticIntent.structuredContent).toHaveProperty("interpretation.requestText", "분노와 허탈함이 섞였는데 차갑고 단단하게 집중하고 싶어");
      const fallbackUrls = listenBrainzFetch.mock.calls.slice(fallbackCallStart)
        .map(([input]) => input instanceof Request ? input.url : input.toString());
      expect(fallbackUrls.every((url) => !decodeURIComponent(url).includes("허탈함"))).toBe(true);

      const emptySemanticIntent = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "빈 의미 객체로는 추측하지 마", semanticIntent: {}, minutes: 20 }
      });
      expect(emptySemanticIntent.isError).not.toBe(true);
      expect(emptySemanticIntent.structuredContent).toHaveProperty("interpretation.semanticSource", "legacy_compatibility");
      expect(emptySemanticIntent.structuredContent).toHaveProperty("interpretation.semanticCoverage", "canonical_fallback");

      const negatedActivity = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "운동은 싫고 편안하게 쉬면서 들을 노래를 추천해줘" }
      });
      expect(negatedActivity.isError).not.toBe(true);
      expect(negatedActivity.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");
      const negatedActivityTags = (negatedActivity.structuredContent?.interpretation as { discoveryTags: string[] }).discoveryTags;
      expect(negatedActivityTags).not.toContain("workout");
      expect(negatedActivityTags).not.toContain("energetic");

      const structuredNegatedActivity = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "운동은 싫고 산책하며 편안하게 듣고 싶어",
          activity: "운동은 싫고 산책"
        }
      });
      const structuredActivityTags = (structuredNegatedActivity.structuredContent?.interpretation as { discoveryTags: string[] }).discoveryTags;
      expect(structuredActivityTags).toContain("walking");
      expect(structuredActivityTags).not.toContain("workout");

      const negatedWeather = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "비 오는 날 노래는 싫고 화창한 날 같은 곡을 골라줘" }
      });
      expect(negatedWeather.isError).not.toBe(true);
      expect(negatedWeather.structuredContent).toHaveProperty("interpretation.semanticSource", "legacy_compatibility");
      expect(negatedWeather.structuredContent).toHaveProperty("interpretation.semanticCoverage", "canonical_fallback");
      expect(negatedWeather.structuredContent).toHaveProperty("interpretation.discoveryTags", []);

      const noSignalFallback = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "아무 설명 없이 그냥 알아서 골라줘" }
      });
      expect(noSignalFallback.isError).not.toBe(true);
      expect(noSignalFallback.structuredContent).toHaveProperty("interpretation.semanticSource", "legacy_compatibility");
      expect(noSignalFallback.structuredContent).toHaveProperty("interpretation.semanticCoverage", "canonical_fallback");

      for (const standaloneRejection of [
        "우울한 건 마음에 안 들어",
        "우울한 건 내 스타일이 아니야",
        "I don't feel like sad songs",
        "첫 곡이 별로야. 우울한 느낌이라 빼줘",
        "우울한 노래 추천은 하지 마",
        "우울한 노래를 추천하지는 말아줘",
        "우울한 곡은 추천 안 해줘도 돼",
        "I don't need any sad songs",
        "I wouldn't recommend sad songs",
        "Don't play sad songs",
        "happy songs are not what I want",
        "sad songs are not what I'm looking for",
        "차분한 노래는 필요 없어",
        "차분한 노래 추천할 필요 없어",
        "차분한 건 원하지는 않아",
        "차분한 노래는 듣고 싶진 않아",
        "I don't really want sad songs",
        "I do not really want sad songs",
        "No need for sad songs",
        "Anything but sad songs",
        "I'd rather not listen to sad songs",
        "I prefer not to hear sad songs",
        "I'm not exactly looking for sad songs",
        "I don't think that I really want sad songs",
        "우울한 노래는 사양할게",
        "신나는 노래는 내키지 않아",
        "차분한 노래는 안 땡겨",
        "차분한 노래를 바라는 건 아니야",
        "우울한 노래를 추천해달라는 건 아니야",
        "Sad songs? No thanks.",
        "Sad songs? I would pass.",
        "Sad songs? Hard pass.",
        "Sad songs? Nope.",
        "Keep sad songs off the list",
        "I don't prefer sad over happy songs",
        "슬픈 노래를 틀지 않을 거야",
        "차분한 것보다 신나는 게 좋은 건 아니야",
        "우울한 노래는 말자",
        "우울한 노래는 넘기자",
        "우울한 노래는 피하고 싶어",
        "우울한 노래는 스킵",
        "우울한 건 좀 그래",
        "우울한 건 부담스러워",
        "우울한 건 싫고 신나는 건 됐어",
        "우울한 건 싫고 신나는 노래는 패스",
        "sad songs are bad but happy songs? no thanks",
        "not sad, but happy is not for me",
        "Never play sad songs",
        "Never recommend sad songs",
        "Under no circumstances play sad songs",
        "You should never play sad songs",
        "I refuse to play sad songs",
        "I don't mean sad rather than happy songs",
        "우울한 노래 추천해주지 마",
        "슬픈 노래 틀어주지 마",
        "차분한 노래 들려주지 마",
        "신나는 노래 재생해주지 마",
        "우울한 노래는 됐어",
        "우울한 노래는 패스"
      ]) {
        const rejectedStandalone = await client.callTool({
          name: "build_live_mood_journey",
          arguments: { requestText: standaloneRejection }
        });
        expect(rejectedStandalone.isError).not.toBe(true);
        expect(rejectedStandalone.structuredContent).toHaveProperty("interpretation.semanticSource", "legacy_compatibility");
        expect(rejectedStandalone.structuredContent).toHaveProperty("interpretation.semanticCoverage", "canonical_fallback");
        expect(rejectedStandalone.structuredContent).toHaveProperty("interpretation.discoveryTags", []);
      }

      for (const [naturalRequest, expectedMood] of [
        ["잔잔한 노래 틀어줘", "calm"],
        ["좀 더 신나게", "joyful"],
        ["슬픈 노래 좀", "sad"],
        ["Sad music please", "sad"],
        ["Give me happy songs", "joyful"],
        ["Can you put on calm songs?", "calm"],
        ["오늘 날씨가 더운데 시원한 플레이리스트를 찾아줘", "energetic"],
        ["오늘 날씨가 더운 데 시원한 플레이리스트를 찾아줘", "energetic"],
        ["너무 더워서 시원한 플레이리스트를 찾아줘", "energetic"],
        ["기분이 가라앉았는데 신나는 플리", "joyful"],
        ["편안해지는 음악", "calm"],
        ["기분 좋아지는 노래", "joyful"],
        ["Give me something cool and energetic", "energetic"],
        ["I need uplifting music", "hopeful"]
      ] as const) {
        const naturalStandalone = await client.callTool({
          name: "build_live_mood_journey",
          arguments: { requestText: naturalRequest }
        });
        expect(naturalStandalone.isError).not.toBe(true);
        expect(naturalStandalone.structuredContent, naturalRequest).toHaveProperty("targetMood", expectedMood);
        expect(naturalStandalone.structuredContent, naturalRequest).toHaveProperty("interpretation.semanticSource", "server_inferred");
      }

      const romanticDateRequest = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "로맨틱한 데이트 노래 추천해줘" }
      });
      expect(romanticDateRequest.isError).not.toBe(true);
      expect(romanticDateRequest.structuredContent).toHaveProperty("targetMood", "romantic");
      expect(romanticDateRequest.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");

      const noSignalThenRecognized = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: noSignalFallback.structuredContent?.refinementState,
          changes: { requestText: "이제 신나는 노래로 바꿔줘" }
        }
      });
      expect(noSignalThenRecognized.isError).not.toBe(true);
      expect(noSignalThenRecognized.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(noSignalThenRecognized.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");
      expect(noSignalThenRecognized.structuredContent).toHaveProperty("interpretation.semanticCoverage", "partial");

      const inferredInitial = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { requestText: "비 오는 날 차분한 노래로 골라줘" }
      });
      const reinferredFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredInitial.structuredContent?.refinementState,
          changes: { requestText: "이제 비 노래는 싫고 운동할 때 신나는 걸로 바꿔줘" }
        }
      });
      expect(reinferredFollowup.isError).not.toBe(true);
      expect(reinferredFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(reinferredFollowup.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");
      const reinferredTags = (reinferredFollowup.structuredContent?.interpretation as { discoveryTags: string[] }).discoveryTags;
      expect(reinferredTags).not.toContain("rainy day");
      expect(reinferredTags).not.toContain("workout");

      const mixedFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredInitial.structuredContent?.refinementState,
          changes: { targetSemantic: { valence: 0.82, energy: 0.71, acousticness: 0.3 } }
        }
      });
      expect(mixedFollowup.isError).not.toBe(true);
      expect(mixedFollowup.structuredContent).toHaveProperty("interpretation.semanticSource", "mixed");
      expect(mixedFollowup.structuredContent).toHaveProperty("interpretation.semanticCoverage", "partial");

      const hostSemanticInitial = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "기분을 신나게 올려줄 노래를 추천해줘",
          semanticIntent: {
            current: { valence: 0.2, energy: 0.25, acousticness: 0.7, label: "sad" },
            target: { valence: 0.9, energy: 0.85, acousticness: 0.2, label: "joyful" },
            discoveryTags: ["upbeat"]
          }
        }
      });
      const hostTextOnlyFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: hostSemanticInitial.structuredContent?.refinementState,
          changes: { requestText: "이제 조용하고 차분한 노래로 바꿔줘" }
        }
      });
      expect(hostTextOnlyFollowup.isError).not.toBe(true);
      expect(hostTextOnlyFollowup.structuredContent).toHaveProperty("targetMood", "calm");
      expect(hostTextOnlyFollowup.structuredContent).toHaveProperty("interpretation.semanticSource", "mixed");
      expect(hostTextOnlyFollowup.structuredContent).toHaveProperty("interpretation.semanticCoverage", "partial");
      expect((hostTextOnlyFollowup.structuredContent?.interpretation as { discoveryTags: string[] }).discoveryTags).not.toContain("upbeat");
      expect(hostTextOnlyFollowup.structuredContent).toHaveProperty("refinementState.request.currentMood", "joyful");
      expect(hostTextOnlyFollowup.structuredContent).toHaveProperty("refinementState.request.targetMood", "calm");

      const mixedTextOnlyFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: mixedFollowup.structuredContent?.refinementState,
          changes: { requestText: "이제 조용하고 차분한 노래로 바꿔줘" }
        }
      });
      expect(mixedTextOnlyFollowup.isError).not.toBe(true);
      expect(mixedTextOnlyFollowup.structuredContent).toHaveProperty("targetMood", "calm");
      expect(mixedTextOnlyFollowup.structuredContent).toHaveProperty("interpretation.semanticSource", "mixed");
      expect(mixedTextOnlyFollowup.structuredContent).toHaveProperty("interpretation.semanticCoverage", "partial");

      const inferredTransition = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "우울한 기분에서 신나는 노래로 넘어가고 싶어",
          currentMood: "sad",
          targetMood: "joyful"
        }
      });
      const inferredTransitionState = inferredTransition.structuredContent?.refinementState as {
        request: { semanticIntent?: unknown };
      };
      const operationalFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "첫 곡만 빼고 다시 추천해줘" }
        }
      });
      expect(operationalFollowup.isError).not.toBe(true);
      expect(operationalFollowup.structuredContent).toHaveProperty("currentMood", "sad");
      expect(operationalFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(operationalFollowup.structuredContent).toHaveProperty("interpretation.semanticSource", "server_inferred");
      expect(operationalFollowup.structuredContent).toHaveProperty("interpretation.semanticCoverage", "partial");
      expect(operationalFollowup.structuredContent).toHaveProperty(
        "refinementState.request.semanticIntent",
        inferredTransitionState.request.semanticIntent
      );

      const evaluationFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "첫 곡이 별로라서 빼고 다시 추천해줘" }
        }
      });
      expect(evaluationFollowup.isError).not.toBe(true);
      expect(evaluationFollowup.structuredContent).toHaveProperty("currentMood", "sad");
      expect(evaluationFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(evaluationFollowup.structuredContent).toHaveProperty(
        "refinementState.request.semanticIntent",
        inferredTransitionState.request.semanticIntent
      );

      const rejectedMoodFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "우울한 곡은 빼고 다시 추천해줘" }
        }
      });
      expect(rejectedMoodFollowup.isError).not.toBe(true);
      expect(rejectedMoodFollowup.structuredContent).toHaveProperty("currentMood", "sad");
      expect(rejectedMoodFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(rejectedMoodFollowup.structuredContent).toHaveProperty(
        "refinementState.request.semanticIntent",
        inferredTransitionState.request.semanticIntent
      );

      const acknowledgementFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "좋아, 첫 곡만 빼줘" }
        }
      });
      expect(acknowledgementFollowup.isError).not.toBe(true);
      expect(acknowledgementFollowup.structuredContent).toHaveProperty("currentMood", "sad");
      expect(acknowledgementFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      expect(acknowledgementFollowup.structuredContent).toHaveProperty(
        "refinementState.request.semanticIntent",
        inferredTransitionState.request.semanticIntent
      );

      for (const rejectedText of [
        "우울한 노래는 안 듣고 싶어",
        "우울한 곡들은 빼줘",
        "우울함은 제외해줘",
        "I don't want sad songs",
        "sad songs I don't want",
        "우울한 건 마음에 안 들어",
        "우울한 건 내 스타일이 아니야",
        "I don't feel like sad songs",
        "happy songs aren't what I want",
        "sad songs are not what I'm looking for",
        "첫 곡이 별로야. 우울한 느낌이라 빼줘",
        "우울한 노래 추천은 하지 마",
        "우울한 노래를 추천하지는 말아줘",
        "우울한 곡은 추천 안 해줘도 돼",
        "I don't need any sad songs",
        "I wouldn't recommend sad songs",
        "Don't play sad songs",
        "차분한 노래는 필요 없어",
        "차분한 노래 추천할 필요 없어",
        "차분한 건 원하지는 않아",
        "차분한 노래는 듣고 싶진 않아",
        "I don't really want sad songs",
        "I do not really want sad songs",
        "No need for sad songs",
        "Anything but sad songs",
        "I'd rather not listen to sad songs",
        "I prefer not to hear sad songs",
        "I'm not exactly looking for sad songs",
        "I don't think that I really want sad songs",
        "우울한 노래는 사양할게",
        "신나는 노래는 내키지 않아",
        "차분한 노래는 안 땡겨",
        "차분한 노래를 바라는 건 아니야",
        "우울한 노래를 추천해달라는 건 아니야",
        "Sad songs? No thanks.",
        "Sad songs? I would pass.",
        "Sad songs? Hard pass.",
        "Sad songs? Nope.",
        "Keep sad songs off the list",
        "I don't prefer sad over happy songs",
        "슬픈 노래를 틀지 않을 거야",
        "차분한 것보다 신나는 게 좋은 건 아니야",
        "우울한 노래는 말자",
        "우울한 노래는 넘기자",
        "우울한 노래는 피하고 싶어",
        "우울한 노래는 스킵",
        "우울한 건 좀 그래",
        "우울한 건 부담스러워",
        "우울한 건 싫고 신나는 건 됐어",
        "우울한 건 싫고 신나는 노래는 패스",
        "sad songs are bad but happy songs? no thanks",
        "not sad, but happy is not for me",
        "Never play sad songs",
        "Never recommend sad songs",
        "Under no circumstances play sad songs",
        "You should never play sad songs",
        "I refuse to play sad songs",
        "I don't mean sad rather than happy songs",
        "우울한 노래 추천해주지 마",
        "슬픈 노래 틀어주지 마",
        "차분한 노래 들려주지 마",
        "신나는 노래 재생해주지 마",
        "우울한 노래는 됐어",
        "우울한 노래는 패스"
      ]) {
        const rejectedQualityFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: rejectedText }
          }
        });
        expect(rejectedQualityFollowup.isError).not.toBe(true);
        expect(rejectedQualityFollowup.structuredContent).toHaveProperty("currentMood", "sad");
        expect(rejectedQualityFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
        expect(rejectedQualityFollowup.structuredContent).toHaveProperty(
          "refinementState.request.semanticIntent",
          inferredTransitionState.request.semanticIntent
        );
      }

      for (const [naturalRequest, expectedMood] of [
        ["잔잔한 노래 틀어줘", "calm"],
        ["좀 더 신나게", "joyful"],
        ["슬픈 노래 좀", "sad"],
        ["Sad music please", "sad"],
        ["Give me happy songs", "joyful"],
        ["Can you put on calm songs?", "calm"],
        ["오늘 날씨가 더운데 시원한 플레이리스트를 찾아줘", "energetic"],
        ["오늘 날씨가 더운 데 시원한 플레이리스트를 찾아줘", "energetic"],
        ["너무 더워서 시원한 플레이리스트를 찾아줘", "energetic"],
        ["기분이 가라앉았는데 신나는 플리", "joyful"],
        ["편안해지는 음악", "calm"],
        ["기분 좋아지는 노래", "joyful"],
        ["Give me something cool and energetic", "energetic"],
        ["I need uplifting music", "hopeful"]
      ] as const) {
        const naturalFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: naturalRequest }
          }
        });
        expect(naturalFollowup.isError).not.toBe(true);
        expect(naturalFollowup.structuredContent, naturalRequest).toHaveProperty("currentMood", "joyful");
        expect(naturalFollowup.structuredContent, naturalRequest).toHaveProperty("targetMood", expectedMood);
      }

      const contrastTargetFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "신나는 곡은 빼고 차분한 곡으로 추천해줘" }
        }
      });
      expect(contrastTargetFollowup.isError).not.toBe(true);
      expect(contrastTargetFollowup.structuredContent).toHaveProperty("currentMood", "joyful");
      expect(contrastTargetFollowup.structuredContent).toHaveProperty("targetMood", "calm");

      const doubleNegativeFollowup = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "우울한 곡은 빼지 말고 추천해줘" }
        }
      });
      expect(doubleNegativeFollowup.isError).not.toBe(true);
      expect(doubleNegativeFollowup.structuredContent).toHaveProperty("currentMood", "joyful");
      expect(doubleNegativeFollowup.structuredContent).toHaveProperty("targetMood", "sad");

      for (const wantedDoubleNegative of ["신나는 건 싫은 건 아니야", "신나는 건 싫지는 않아"]) {
        const wantedDoubleNegativeFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: wantedDoubleNegative }
          }
        });
        expect(wantedDoubleNegativeFollowup.isError).not.toBe(true);
        expect(wantedDoubleNegativeFollowup.structuredContent).toHaveProperty("currentMood", "joyful");
        expect(wantedDoubleNegativeFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      }

      for (const contrastedTarget of [
        "신나는 곡은 원하지 않지만 차분한 노래를 원해",
        "I don't want happy songs and I want calm songs",
        "I don't want sad songs, calm instead",
        "신나는 거 말고 차분한 거",
        "신나는 것보다 차분한 거",
        "우울하지 않고 차분한 노래",
        "슬프지 않은 차분한 노래 추천해줘"
      ]) {
        const contrastedTargetFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: contrastedTarget }
          }
        });
        expect(contrastedTargetFollowup.isError).not.toBe(true);
        expect(contrastedTargetFollowup.structuredContent).toHaveProperty("currentMood", "joyful");
        expect(contrastedTargetFollowup.structuredContent).toHaveProperty("targetMood", "calm");
      }

      for (const joyfulContrast of [
        "차분한 노래 대신 신나는 노래",
        "우울한 노래 추천해줘 말고 신나는 노래",
        "우울한 노래를 추천해달라는 건 아니고 신나는 노래 추천해줘",
        "차분한 것보다 신나는 거",
        "우울한 건 됐고 신나는 노래",
        "우울한 곡은 됐고 신나는 걸로",
        "우울한 건 그만, 신나는 노래"
      ]) {
        const joyfulContrastFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: joyfulContrast }
          }
        });
        expect(joyfulContrastFollowup.isError).not.toBe(true);
        expect(joyfulContrastFollowup.structuredContent).toHaveProperty("currentMood", "joyful");
        expect(joyfulContrastFollowup.structuredContent).toHaveProperty("targetMood", "joyful");
      }

      for (const sadComparison of [
        "sad rather than happy songs",
        "sad instead of happy songs",
        "I prefer sad over happy songs",
        "Why not play sad songs?",
        "Sad songs are not bad",
        "우울한 노래도 나쁘지 않아",
        "슬픈 노래를 틀지 않을 수 없어",
        "우울한 노래를 빼지 않을 거야"
      ]) {
        const sadComparisonFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: sadComparison }
          }
        });
        expect(sadComparisonFollowup.isError).not.toBe(true);
        expect(sadComparisonFollowup.structuredContent, sadComparison).toHaveProperty("currentMood", "joyful");
        expect(sadComparisonFollowup.structuredContent, sadComparison).toHaveProperty("targetMood", "sad");
      }

      const dislikedThenCalm = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          refinementState: inferredTransition.structuredContent?.refinementState,
          changes: { requestText: "신나는 노래는 싫은데 차분한 거" }
        }
      });
      expect(dislikedThenCalm.isError).not.toBe(true);
      expect(dislikedThenCalm.structuredContent).toHaveProperty("currentMood", "joyful");
      expect(dislikedThenCalm.structuredContent).toHaveProperty("targetMood", "calm");

      for (const affirmativeDoubleNegative of [
        "신나는 노래를 대신 추천해줘",
        "신나는 노래를 추천하지 않을 수 없어",
        "don't not play happy songs",
        "can't not play happy songs"
      ]) {
        const affirmativeDoubleNegativeFollowup = await client.callTool({
          name: "refine_mood_journey",
          arguments: {
            refinementState: inferredTransition.structuredContent?.refinementState,
            changes: { requestText: affirmativeDoubleNegative }
          }
        });
        expect(affirmativeDoubleNegativeFollowup.isError).not.toBe(true);
        expect(affirmativeDoubleNegativeFollowup.structuredContent, affirmativeDoubleNegative).toHaveProperty("currentMood", "joyful");
        expect(affirmativeDoubleNegativeFollowup.structuredContent, affirmativeDoubleNegative).toHaveProperty("targetMood", "joyful");
      }

      const sensitiveCatalogTag = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "비밀 문자열을 음악 태그로 보내면 안 돼",
          semanticIntent: { discoveryTags: ["password hunter2", "calm"] },
          minutes: 20
        }
      });
      expect(sensitiveCatalogTag.isError).toBe(true);

      const personalNumericTag = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "전화번호 같은 값도 음악 태그로 보내면 안 돼",
          semanticIntent: { discoveryTags: ["phone 010 1234 5678", "calm"] },
          minutes: 20
        }
      });
      expect(personalNumericTag.isError).toBe(true);

      for (const personalTextTag of [
        "my name is john smith",
        "name john smith",
        "full name john smith",
        "account number 1234 5678",
        "phone 1234 5678",
        "address 12 main street",
        "이름 홍길동",
        "내 이름은 홍길동",
        "성명 홍길동"
      ]) {
        const personalText = await client.callTool({
          name: "build_live_mood_journey",
          arguments: {
            requestText: "개인정보 문구는 검색 태그로 보내면 안 돼",
            semanticIntent: { discoveryTags: [personalTextTag, "calm"] },
            minutes: 20
          }
        });
        expect(personalText.isError, personalTextTag).toBe(true);
      }

      const opaqueCredentialTag = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "자격 증명처럼 보이는 값을 음악 태그로 보내면 안 돼",
          semanticIntent: { discoveryTags: ["akiaiosfodnn7example", "calm"] },
          minutes: 20
        }
      });
      expect(opaqueCredentialTag.isError).toBe(true);

      const requestSentenceTag = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "전체 요청 문장을 검색 태그로 복사하면 안 돼",
          semanticIntent: { discoveryTags: ["please play my breakup songs", "calm"] },
          minutes: 20
        }
      });
      expect(requestSentenceTag.isError).toBe(true);

      const legitimateCatalogPhrases = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "뮤지컬 느낌의 쇼튠을 듣고 싶어",
          semanticIntent: { discoveryTags: ["show tunes", "rock & roll", "drum 'n' bass"] },
          minutes: 20,
          preferences: { preferredGenres: ["K-Pop", "R&B", "rhythm & blues"] }
        }
      });
      expect(legitimateCatalogPhrases.isError).not.toBe(true);

      const sensitivePreferredGenre = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "sad",
          targetMood: "hopeful",
          minutes: 20,
          preferences: { preferredGenres: ["password hunter2"] }
        }
      });
      expect(sensitivePreferredGenre.isError).toBe(true);

      const tooManyTags = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "검색 태그가 너무 많은 요청",
          semanticIntent: { discoveryTags: Array.from({ length: 9 }, (_, index) => `tag-${index}`) },
          minutes: 20
        }
      });
      expect(tooManyTags.isError).toBe(true);

      const emptyDiscoveryTags = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "빈 검색 태그 배열",
          semanticIntent: { discoveryTags: [] },
          minutes: 20
        }
      });
      expect(emptyDiscoveryTags.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("filters semantic exclusion tags from an upstream candidate batch", async () => {
    const client = new Client({ name: "semantic-exclusion-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const result = await client.callTool({
        name: "arrange_candidate_mood_journey",
        arguments: {
          requestText: "거칠고 시끄러운 메탈은 빼고 차분하지만 또렷한 곡으로 골라줘",
          semanticIntent: {
            current: { label: "지친 상태", valence: 0.3, energy: 0.3, acousticness: 0.65 },
            target: { label: "차분하지만 또렷한 상태", valence: 0.62, energy: 0.38, acousticness: 0.72 },
            discoveryTags: ["calm", "focused"],
            excludeTags: ["metal"]
          },
          minutes: 20,
          candidateSource: { providerName: "Authorized test provider" },
          candidates: [
            ...Array.from({ length: 3 }, (_, index) => ({
              providerTrackId: `metal-${index}`,
              title: `Excluded Metal ${index}`,
              artist: `Loud Artist ${index}`,
              durationSec: 180,
              moodTags: ["metal", "energetic"]
            })),
            ...Array.from({ length: 5 }, (_, index) => ({
              providerTrackId: `calm-${index}`,
              title: `Allowed Calm ${index}`,
              artist: `Calm Artist ${index}`,
              durationSec: 180,
              moodTags: ["calm", "focused"]
            }))
          ]
        }
      });
      expect(result.isError).not.toBe(true);
      const titles = (result.structuredContent?.stages as Array<{ tracks: Array<{ title: string }> }>)
        .flatMap((stage) => stage.tracks.map((track) => track.title));
      expect(titles.length).toBeGreaterThanOrEqual(3);
      expect(titles.every((title) => title.startsWith("Allowed Calm"))).toBe(true);
      expect(result.structuredContent).toHaveProperty("refinementState.request.tasteProfile.avoidGenres", ["metal"]);
      expect(result.structuredContent).toHaveProperty("refinementState.request.semanticIntent.excludeTags", ["metal"]);
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

  it("keeps exact discovery decisions cached across stateless MCP POST requests", async () => {
    const musicBrainzService = new StubMusicBrainzService();
    const searchCandidates = vi.spyOn(musicBrainzService, "searchCandidates");
    const cacheApp = createApp({
      listenBrainzService: new ListenBrainzService({
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("ListenBrainz must not be called"))
      }),
      musicBrainzService
    });
    const cacheServer = await new Promise<HttpServer>((resolve) => {
      const candidate = cacheApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = cacheServer.address() as AddressInfo;
    const client = new Client({ name: "app-cache-lifetime-test", version: "1.0.0" });
    const arguments_ = {
      currentMood: "tired",
      targetMood: "refreshed",
      minutes: 20,
      preferences: { preferredArtists: ["TWICE"], artistScope: "only" }
    };
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const first = await client.callTool({ name: "build_live_mood_journey", arguments: arguments_ });
      const second = await client.callTool({ name: "build_live_mood_journey", arguments: arguments_ });
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(searchCandidates).toHaveBeenCalledTimes(1);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => cacheServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not call MusicBrainz when ListenBrainz already supplies a rankable general pool", async () => {
    let releaseGeneral!: () => void;
    const generalGate = new Promise<void>((resolve) => { releaseGeneral = resolve; });
    class HangingGeneralMusicBrainzService extends StubMusicBrainzService {
      tagSearchCalls = 0;

      override async searchCandidates(input: MusicBrainzCandidateQuery): Promise<MusicBrainzCandidateResult> {
        if (input.tags?.length) {
          this.tagSearchCalls += 1;
          await generalGate;
          return {
            candidates: [],
            matchedArtists: [],
            matchedArtistNames: [],
            matchedArtistMbids: [],
            source: "musicbrainz-live",
            attribution: MUSICBRAINZ_ATTRIBUTION,
            fetchedAt: "2026-07-13T00:00:00.000Z"
          };
        }
        return super.searchCandidates(input);
      }
    }
    const musicBrainzService = new HangingGeneralMusicBrainzService();
    const raceApp = createApp({
      listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch }),
      musicBrainzService
    });
    const raceServer = await new Promise<HttpServer>((resolve) => {
      const candidate = raceApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = raceServer.address() as AddressInfo;
    const client = new Client({ name: "public-source-race-test", version: "1.0.0" });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await Promise.race([
        client.callTool({
          name: "build_live_mood_journey",
          arguments: { currentMood: "content", targetMood: "hopeful", minutes: 20 }
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("fast public source was blocked by the hanging source")), 1_000);
        })
      ]);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("selectionScope.kind", "public_open_catalog");
      expect(musicBrainzService.tagSearchCalls).toBe(0);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseGeneral();
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => raceServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not queue the delayed MusicBrainz hedge when fast ListenBrainz metadata is already semantically strict", async () => {
    class CountingMusicBrainzService extends StubMusicBrainzService {
      tagSearchCalls = 0;

      override async searchCandidates(input: MusicBrainzCandidateQuery): Promise<MusicBrainzCandidateResult> {
        if (input.tags?.length) this.tagSearchCalls += 1;
        return super.searchCandidates(input);
      }
    }

    const musicBrainzService = new CountingMusicBrainzService();
    const strictListenBrainzApp = createApp({
      listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch }),
      musicBrainzService
    });
    const strictListenBrainzServer = await new Promise<HttpServer>((resolve) => {
      const candidate = strictListenBrainzApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = strictListenBrainzServer.address() as AddressInfo;
    const client = new Client({ name: "strict-listenbrainz-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "가라앉은 상태에서 자연스럽게 희망적인 쪽으로 이어지는 노래",
          semanticIntent: { discoveryTags: ["sad", "content", "hopeful"] },
          minutes: 20
        }
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("context.contextMatchMode", "strict");
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(musicBrainzService.tagSearchCalls).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => strictListenBrainzServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("hedges MusicBrainz tags when a context request needs a feasible public batch", async () => {
    const musicBrainzService = new TagMusicBrainzService();
    const contextFallbackApp = createApp({
      listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch }),
      musicBrainzService
    });
    const contextServer = await new Promise<HttpServer>((resolve) => {
      const candidate = contextFallbackApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = contextServer.address() as AddressInfo;
    const client = new Client({ name: "strict-context-fallback-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: { weather: "hot", desiredVibe: "refreshing", minutes: 20 }
      });
      expect(result.isError).not.toBe(true);
      expect(musicBrainzService.tagQueries).toHaveLength(1);
      expect(result.structuredContent).toHaveProperty("selectionScope.kind", "public_open_catalog");
      expect((result.structuredContent?.selectionScope as { candidateCount: number }).candidateCount).toBeGreaterThanOrEqual(3);
      expect(result.structuredContent).toHaveProperty("context.contextMatchMode", "strict");
      expect(result.structuredContent).toHaveProperty("sources", expect.arrayContaining([
        expect.objectContaining({ name: "MusicBrainz" })
      ]));
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => contextServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("waits within the hedge window for a strict semantic batch instead of keeping a faster unrelated batch", async () => {
    class DelayedStrictMusicBrainzService extends TagMusicBrainzService {
      override async searchCandidates(input: MusicBrainzCandidateQuery): Promise<MusicBrainzCandidateResult> {
        if (input.tags?.length) await new Promise<void>((resolve) => setTimeout(resolve, 80));
        return super.searchCandidates(input);
      }
    }

    const musicBrainzService = new DelayedStrictMusicBrainzService();
    const strictHedgeApp = createApp({
      listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch }),
      musicBrainzService
    });
    const strictHedgeServer = await new Promise<HttpServer>((resolve) => {
      const candidate = strictHedgeApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = strictHedgeServer.address() as AddressInfo;
    const client = new Client({ name: "strict-semantic-hedge-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          requestText: "답답한 더위를 씻어낼 상쾌하고 신나는 노래를 틀어줘",
          semanticIntent: {
            current: { valence: 0.3, energy: 0.35, acousticness: 0.35 },
            target: { valence: 0.8, energy: 0.8, acousticness: 0.2 },
            discoveryTags: ["refreshing", "upbeat"]
          },
          minutes: 20
        }
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("context.contextMatchMode", "strict");
      expect(result.structuredContent).toHaveProperty("interpretation.matchedSemanticTags", ["refreshing", "upbeat"]);
      expect(result.structuredContent).toHaveProperty("interpretation.unmatchedSemanticTags", []);
      expect(result.structuredContent).toHaveProperty("sources", expect.arrayContaining([
        expect.objectContaining({ name: "MusicBrainz" })
      ]));
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => strictHedgeServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("passes seedArtistMbid to the MusicBrainz tag fallback when ListenBrainz is unavailable", async () => {
    const unavailableListenBrainz = new ListenBrainzService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    });
    const musicBrainzService = new TagMusicBrainzService();
    const musicBrainzFallbackApp = createApp({
      listenBrainzService: unavailableListenBrainz,
      musicBrainzService
    });
    const fallbackServer = await new Promise<HttpServer>((resolve) => {
      const candidate = musicBrainzFallbackApp.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = fallbackServer.address() as AddressInfo;
    const client = new Client({ name: "musicbrainz-tag-fallback-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "build_live_mood_journey",
        arguments: {
          currentMood: "더운",
          targetMood: "시원한",
          seedArtistMbid: RESCENE_MBID,
          minutes: 20
        }
      });
      expect(result.isError).not.toBe(true);
      expect(musicBrainzService.tagQueries).toHaveLength(1);
      expect(musicBrainzService.tagQueries[0]?.artistMbids).toEqual([RESCENE_MBID]);
      expect(result.structuredContent).toHaveProperty("selectionScope", expect.objectContaining({
        kind: "public_open_catalog",
        candidateCount: 3
      }));
      expect(result.structuredContent).toHaveProperty("context.contextMatchMode", "strict");
      expect(result.structuredContent).toHaveProperty("sources", [expect.objectContaining({ name: "MusicBrainz" })]);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => fallbackServer.close((error) => error ? reject(error) : resolve()));
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
    const fallbackApp = createApp({
      listenBrainzService: new ListenBrainzService({ fetchImpl: failedFetch }),
      musicBrainzService: new MusicBrainzService({ fetchImpl: failedFetch })
    });
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
