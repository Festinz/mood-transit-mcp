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

  const client = new Client({ name: "mood-transit-smoke", version: "2.0.1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const expected = ["arrange_candidate_mood_journey", "build_live_mood_journey", "refine_mood_journey"];
    if (JSON.stringify(toolNames) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${toolNames.join(", ")}`);

    const live = await client.callTool({
      name: "build_live_mood_journey",
      arguments: {
        currentMood: "울적",
        targetMood: "hopeful",
        weather: "rain",
        activity: "commute",
        minutes: 20,
        preferences: { preferredGenres: ["k-pop"], discovery: "adventurous" }
      }
    });

    const arranged = await client.callTool({
      name: "arrange_candidate_mood_journey",
      arguments: {
        currentMood: "sad",
        targetMood: "hopeful",
        minutes: 20,
        candidateSource: { providerName: "Melon MCP", toolName: "recommend_personalized_songs_by_dj_mallang" },
        candidates: Array.from({ length: 8 }, (_, index) => ({
          providerTrackId: `smoke-${index + 1}`,
          title: `Smoke Candidate ${index + 1}`,
          artist: `Smoke Artist ${index + 1}`,
          durationSec: 175 + index * 6,
          originalRank: index + 1,
          moodTags: index < 3 ? ["sad"] : index < 6 ? ["content"] : ["hopeful"],
          personalizationScore: Math.max(0, 1 - index * 0.08)
        }))
      }
    });
    const arrangedStructured = (arranged.structuredContent ?? {}) as Record<string, unknown>;
    const refinementState = arrangedStructured.refinementState;
    if (!refinementState) throw new Error("Arrange result did not return refinementState");
    const refined = await client.callTool({
      name: "refine_mood_journey",
      arguments: {
        refinementState,
        changes: { discoveryDirection: "more_discovery", excludeTrackIds: ["smoke-1"] }
      }
    });

    if (live.isError || arranged.isError || refined.isError) throw new Error("A representative tool call returned isError");
    const liveStructured = (live.structuredContent ?? {}) as Record<string, unknown>;
    const refinedStructured = (refined.structuredContent ?? {}) as Record<string, unknown>;
    const liveScope = (liveStructured.selectionScope ?? {}) as { kind?: string; candidateCount?: number; statementKo?: string };
    const arrangedScope = (arrangedStructured.selectionScope ?? {}) as { kind?: string; candidateCount?: number };
    if (process.env.REQUIRE_LIVE_CATALOG === "1" && liveScope.kind !== "public_open_catalog") {
      throw new Error(`Live catalog was required but source was ${liveScope.kind ?? "missing"}`);
    }

    process.stdout.write(`${JSON.stringify({
      endpoint,
      tools: toolNames,
      calls: "ok",
      liveCatalog: liveScope,
      providedCandidates: arrangedScope,
      refinedRevision: refinedStructured.revision
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
    if (localServer) await new Promise<void>((resolve, reject) => localServer?.close((error) => error ? reject(error) : resolve()));
  }
}

await main();
