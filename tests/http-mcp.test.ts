import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { SERVER_NAME } from "../src/mcp/server.js";
import { WeatherService } from "../src/services/weather.js";

const weatherFetch = vi.fn<typeof fetch>()
  .mockResolvedValueOnce(new Response(JSON.stringify({ current: { temperature_2m: 25, apparent_temperature: 26, weather_code: 1, wind_speed_10m: 7, time: "2026-07-12T12:00" } }), { status: 200 }));
const app = createApp({ weatherService: new WeatherService({ fetchImpl: weatherFetch }) });
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
      expect(list.tools.map((tool) => tool.name).sort()).toEqual(["build_mood_journey", "build_weather_journey", "refine_mood_journey"]);
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
          openWorldHint: tool.name === "build_weather_journey"
        }));
      }

      const local = await client.callTool({ name: "build_mood_journey", arguments: { currentMood: "울적", targetMood: "joyful", weather: "rain", activity: "commute", minutes: 20 } });
      expect(local.isError).not.toBe(true);
      const previousTrackIds = Object.values((local.structuredContent?.trackIdsByPhase ?? {}) as Record<string, string[]>).flat();
      expect(previousTrackIds.length).toBeGreaterThanOrEqual(3);

      const refined = await client.callTool({
        name: "refine_mood_journey",
        arguments: {
          previousTrackIds,
          previousCurrentMood: "sad",
          previousTargetMood: "joyful",
          previousRequestedMinutes: 20,
          previousContext: { weather: "rain", activity: "commute" },
          feedback: "calmer",
          avoidArtists: ["IU"]
        }
      });
      expect(refined.isError).not.toBe(true);
      expect((refined.content[0] as { text: string }).text).toContain("Mirror");

      const weather = await client.callTool({ name: "build_weather_journey", arguments: { city: "Seoul", currentMood: "tired", targetMood: "focused", activity: "work", minutes: 15, instrumentalOnly: true } });
      expect(weather.isError).not.toBe(true);
      expect((weather.content[0] as { text: string }).text).toContain("Open-Meteo");
      expect(weather.structuredContent).toHaveProperty("weather.attribution", "Open-Meteo data, adapted and classified by MoodTransit (CC BY 4.0)");
      expect(weather.structuredContent).toHaveProperty("weather.licenseUrl", "https://creativecommons.org/licenses/by/4.0/");
    } finally {
      await client.close();
    }
  });

  it("returns bounded schema errors for invalid input", async () => {
    const client = new Client({ name: "invalid-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    try {
      const result = await client.callTool({ name: "build_mood_journey", arguments: { currentMood: "sad", targetMood: "calm", minutes: 2 } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(5_000);
    } finally {
      await client.close();
    }
  });
});
