import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";

async function main(): Promise<void> {
  let localServer: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  let endpoint = process.env.MCP_URL;
  if (!endpoint) {
    const app = createApp();
    localServer = await new Promise((resolve) => {
      const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const address = localServer!.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
  }

  const client = new Client({ name: "mood-transit-smoke", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const listed = await client.listTools();
    if (listed.tools.length !== 3) throw new Error(`Expected 3 tools, received ${listed.tools.length}`);
    const first = await client.callTool({
      name: "build_mood_journey",
      arguments: { currentMood: "울적", targetMood: "hopeful", weather: "rain", activity: "commute", minutes: 20 }
    });
    const firstStructured = (first.structuredContent ?? {}) as Record<string, unknown>;
    const previousTrackIds = Object.values((firstStructured.trackIdsByPhase ?? {}) as Record<string, string[]>).flat();
    if (previousTrackIds.length < 3) throw new Error("First call returned too few track IDs");
    const refined = await client.callTool({
      name: "refine_mood_journey",
      arguments: {
        previousTrackIds,
        previousCurrentMood: "sad",
        previousTargetMood: "hopeful",
        previousRequestedMinutes: 20,
        previousContext: { weather: "rain", activity: "commute" },
        feedback: "brighter"
      }
    });
    const weather = await client.callTool({
      name: "build_weather_journey",
      arguments: { city: "Seoul", currentMood: "tired", targetMood: "focused", activity: "work", minutes: 15, instrumentalOnly: true }
    });
    if (first.isError || refined.isError || weather.isError) throw new Error("A representative tool call returned isError");
    const weatherStructured = (weather.structuredContent ?? {}) as { weather?: { source?: string; city?: string; condition?: string } };
    process.stdout.write(`${JSON.stringify({ endpoint, tools: listed.tools.map((tool) => tool.name), calls: "ok", weather: weatherStructured.weather ?? { source: "missing" } }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
    if (localServer) await new Promise<void>((resolve, reject) => localServer?.close((error) => error ? reject(error) : resolve()));
  }
}

await main();
