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
const app = createApp({
  weatherService: new WeatherService({ fetchImpl: weatherFetch }),
  listenBrainzService: new ListenBrainzService({ fetchImpl: listenBrainzFetch })
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
