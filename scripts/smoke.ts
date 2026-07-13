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

    const client = new Client({ name: "mood-transit-smoke", version: "2.3.1" });
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

    const hotWeatherLive = await client.callTool({
      name: "build_live_mood_journey",
      arguments: {
        currentMood: "더운",
        targetMood: "시원한",
        minutes: 30
      }
    });

    const freeTextRequest = "장맛비 오는 밤에 혼자 운전 중이야. 머리는 복잡하지만 너무 처지지는 않는, 묵직한 베이스와 맑은 보컬의 노래가 필요해";
    const freeTextLive = await client.callTool({
      name: "build_live_mood_journey",
      arguments: {
        requestText: freeTextRequest,
        semanticIntent: {
          current: { valence: 0.31, energy: 0.58, acousticness: 0.36, label: "복잡하고 긴장된 상태" },
          target: { valence: 0.62, energy: 0.55, acousticness: 0.31, label: "또렷하지만 과하게 들뜨지 않은 상태" },
          discoveryTags: ["night drive", "dream pop", "electronic", "clear vocals"],
          excludeTags: ["metal", "sleep"]
        },
        weather: "장맛비",
        activity: "야간 운전",
        minutes: 30
      }
    });

    const artistLive = await client.callTool({
      name: "build_live_mood_journey",
      arguments: {
        currentMood: "기분이 안좋음",
        targetMood: "좋음",
        minutes: 30,
        preferences: { preferredArtists: ["리센느"], artistScope: "only" }
      }
    });

    const screenshotRequestText = "트와이스 노래중 비오는날 듣기 좋은 노래를 추천해줘";
    const twiceRainyLive = await client.callTool({
      name: "build_live_mood_journey",
      arguments: {
        requestText: screenshotRequestText,
        semanticIntent: {
          current: { valence: 0.42, energy: 0.38, acousticness: 0.52, label: "비 오는 날의 차분한 상태" },
          target: { valence: 0.58, energy: 0.46, acousticness: 0.48, label: "포근하고 산뜻한 상태" },
          discoveryTags: ["rainy day", "k-pop", "soft pop"]
        },
        weather: "비 오는 날",
        minutes: 30,
        preferences: { preferredArtists: ["트와이스"], artistScope: "only" }
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

    const failedCalls = [
      { name: "live", result: live },
      { name: "hotWeatherLive", result: hotWeatherLive },
      { name: "freeTextLive", result: freeTextLive },
      { name: "artistLive", result: artistLive },
      { name: "twiceRainyLive", result: twiceRainyLive },
      { name: "arranged", result: arranged },
      { name: "refined", result: refined }
    ].filter(({ result }) => result.isError).map(({ name }) => name);
    if (failedCalls.length > 0) throw new Error(`Representative tool calls returned isError: ${failedCalls.join(", ")}`);
    const liveStructured = (live.structuredContent ?? {}) as Record<string, unknown>;
    const hotWeatherStructured = (hotWeatherLive.structuredContent ?? {}) as Record<string, unknown>;
    const freeTextStructured = (freeTextLive.structuredContent ?? {}) as Record<string, unknown>;
    const artistStructured = (artistLive.structuredContent ?? {}) as Record<string, unknown>;
    const twiceStructured = (twiceRainyLive.structuredContent ?? {}) as Record<string, unknown>;
    const refinedStructured = (refined.structuredContent ?? {}) as Record<string, unknown>;
    const liveScope = (liveStructured.selectionScope ?? {}) as { kind?: string; candidateCount?: number; statementKo?: string };
    const arrangedScope = (arrangedStructured.selectionScope ?? {}) as { kind?: string; candidateCount?: number };
    if (process.env.REQUIRE_LIVE_CATALOG === "1" && liveScope.kind !== "public_open_catalog") {
      throw new Error(`Live catalog was required but source was ${liveScope.kind ?? "missing"}`);
    }
    const hotWeatherScope = (hotWeatherStructured.selectionScope ?? {}) as { kind?: string; candidateCount?: number };
    const hotWeatherContext = (hotWeatherStructured.context ?? {}) as {
      weather?: string;
      desiredVibe?: string;
      contextMatchMode?: string;
    };
    if (
      hotWeatherStructured.currentMood !== "content"
      || hotWeatherStructured.targetMood !== "energetic"
      || hotWeatherContext.weather !== "더운"
      || hotWeatherContext.desiredVibe !== "시원한"
    ) {
      throw new Error("The hot-weather refreshing request was not interpreted correctly");
    }
    if (process.env.REQUIRE_LIVE_CATALOG === "1" && hotWeatherScope.kind !== "public_open_catalog") {
      throw new Error(`Hot-weather live catalog was required but source was ${hotWeatherScope.kind ?? "missing"}`);
    }
    const freeTextScope = (freeTextStructured.selectionScope ?? {}) as { kind?: string; candidateCount?: number };
    const freeTextInterpretation = (freeTextStructured.interpretation ?? {}) as {
      requestText?: string;
      semanticCoverage?: string;
      discoveryTags?: string[];
      currentAxes?: { valence?: number };
      targetAxes?: { valence?: number };
    };
    if (
      freeTextInterpretation.requestText !== freeTextRequest
      || freeTextInterpretation.semanticCoverage !== "full"
      || freeTextInterpretation.currentAxes?.valence !== 0.31
      || freeTextInterpretation.targetAxes?.valence !== 0.62
      || !freeTextInterpretation.discoveryTags?.includes("night drive")
    ) {
      throw new Error("The unrestricted free-text request did not preserve its continuous semantic interpretation");
    }
    if (process.env.REQUIRE_LIVE_CATALOG === "1" && freeTextScope.kind !== "public_open_catalog") {
      throw new Error(`Free-text live catalog was required but source was ${freeTextScope.kind ?? "missing"}`);
    }
    const artistResolution = (artistStructured.searchResolution ?? {}) as { matchedArtists?: string[] };
    const artistStages = (artistStructured.stages ?? []) as Array<{ tracks?: Array<{ artist?: string }> }>;
    const artistTracks = artistStages.flatMap((stage) => stage.tracks ?? []);
    if (!artistResolution.matchedArtists?.includes("RESCENE") || artistTracks.length < 3) {
      throw new Error("Korean artist alias search did not resolve 리센느 to RESCENE candidates");
    }
    if (!artistTracks.every((track) => track.artist?.toLocaleLowerCase("en").includes("rescene"))) {
      throw new Error("artistScope=only returned a track outside the resolved RESCENE artist set");
    }
    const twiceInterpretation = (twiceStructured.interpretation ?? {}) as { requestText?: string; semanticCoverage?: string };
    const twiceResolution = (twiceStructured.searchResolution ?? {}) as { matchedArtists?: string[] };
    const twiceStages = (twiceStructured.stages ?? []) as Array<{ tracks?: Array<{ artist?: string }> }>;
    const twiceTracks = twiceStages.flatMap((stage) => stage.tracks ?? []);
    if (
      twiceInterpretation.requestText !== screenshotRequestText
      || twiceInterpretation.semanticCoverage !== "full"
      || !twiceResolution.matchedArtists?.includes("TWICE")
      || twiceTracks.length < 3
      || !twiceTracks.every((track) => track.artist?.toLocaleLowerCase("en").includes("twice"))
    ) {
      throw new Error("The TWICE rainy-day screenshot request did not resolve to an artist-only public-catalog journey");
    }

    process.stdout.write(`${JSON.stringify({
      endpoint,
      tools: toolNames,
      calls: "ok",
      liveCatalog: liveScope,
      hotWeatherRequest: {
        currentMood: hotWeatherStructured.currentMood,
        targetMood: hotWeatherStructured.targetMood,
        context: hotWeatherContext,
        selectionScope: hotWeatherScope
      },
      freeTextRequest: {
        semanticCoverage: freeTextInterpretation.semanticCoverage,
        discoveryTags: freeTextInterpretation.discoveryTags,
        currentValence: freeTextInterpretation.currentAxes?.valence,
        targetValence: freeTextInterpretation.targetAxes?.valence,
        selectionScope: freeTextScope
      },
      artistSearch: {
        matchedArtists: artistResolution.matchedArtists,
        trackCount: artistTracks.length,
        allTracksMatch: true
      },
      twiceRainySearch: {
        requestText: twiceInterpretation.requestText,
        semanticCoverage: twiceInterpretation.semanticCoverage,
        matchedArtists: twiceResolution.matchedArtists,
        trackCount: twiceTracks.length,
        allTracksMatch: true
      },
      providedCandidates: arrangedScope,
      refinedRevision: refinedStructured.revision
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
    if (localServer) await new Promise<void>((resolve, reject) => localServer?.close((error) => error ? reject(error) : resolve()));
  }
}

await main();
