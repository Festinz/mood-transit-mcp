import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOOL_NAMES = ["build_live_mood_journey", "arrange_candidate_mood_journey", "refine_mood_journey"] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type Phase = "cold" | "warm" | "concurrent";

interface ResultLike {
  isError?: boolean;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
}

interface Sample {
  ms: number;
  ok: boolean;
  error?: string;
  selectionKind?: string;
}

interface Stats {
  count: number;
  successes: number;
  errors: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

interface SemanticAudit {
  passed: boolean;
  semanticSource?: string;
  semanticCoverage?: string;
  contextMatchMode?: string;
  matchedSemanticTags: string[];
  unmatchedSemanticTags: string[];
  reasons: string[];
}

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8000/mcp");
if (!(["http:", "https:"] as const).includes(endpoint.protocol as "http:" | "https:")) throw new Error("MCP_URL must use HTTP(S)");

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  return round(sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1))] ?? 0);
}

function stats(samples: readonly Sample[]): Stats {
  const values = samples.filter((sample) => sample.ok).map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    count: samples.length,
    successes: values.length,
    errors: samples.length - values.length,
    averageMs: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? round(values.at(-1) ?? 0) : null
  };
}

function selectionKind(result: ResultLike | undefined): string | undefined {
  const scope = result?.structuredContent?.selectionScope;
  if (typeof scope !== "object" || scope === null || !("kind" in scope)) return undefined;
  return typeof scope.kind === "string" ? scope.kind : undefined;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  const serialized = JSON.stringify(value);
  return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function auditSemanticResult(result: ResultLike | undefined, requestedTags: readonly string[]): SemanticAudit {
  const raw = result?.structuredContent?.interpretation;
  const interpretation = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const semanticSource = typeof interpretation.semanticSource === "string" ? interpretation.semanticSource : undefined;
  const semanticCoverage = typeof interpretation.semanticCoverage === "string" ? interpretation.semanticCoverage : undefined;
  const contextMatchMode = typeof interpretation.contextMatchMode === "string" ? interpretation.contextMatchMode : undefined;
  const matchedSemanticTags = stringArray(interpretation.matchedSemanticTags);
  const unmatchedSemanticTags = stringArray(interpretation.unmatchedSemanticTags);
  const requested = [...new Set(requestedTags)].sort();
  const reported = [...new Set([...matchedSemanticTags, ...unmatchedSemanticTags])].sort();
  const reasons: string[] = [];
  if (semanticSource !== "host_supplied") reasons.push("semanticSource was not host_supplied");
  if (semanticCoverage !== "full") reasons.push("semanticCoverage was not full");
  if (contextMatchMode !== "strict" && contextMatchMode !== "broadened") reasons.push("contextMatchMode was missing");
  if (JSON.stringify(requested) !== JSON.stringify(reported)) reasons.push("matched/unmatched tags did not partition the requested tags");
  if (matchedSemanticTags.length === 0) reasons.push("no requested semantic tag matched selected public metadata");
  return {
    passed: reasons.length === 0,
    ...(semanticSource ? { semanticSource } : {}),
    ...(semanticCoverage ? { semanticCoverage } : {}),
    ...(contextMatchMode ? { contextMatchMode } : {}),
    matchedSemanticTags,
    unmatchedSemanticTags,
    reasons
  };
}

async function measure(client: Client, name: ToolName, args: Record<string, unknown>): Promise<{ sample: Sample; result?: ResultLike }> {
  const started = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args }) as ResultLike;
    const sample: Sample = {
      ms: performance.now() - started,
      ok: result.isError !== true,
      ...(result.isError === true ? { error: errorText(result.content) } : {}),
      ...(selectionKind(result) ? { selectionKind: selectionKind(result) } : {})
    };
    return { sample, result };
  } catch (error) {
    return { sample: { ms: performance.now() - started, ok: false, error: errorText(error) } };
  }
}

const iterations = bounded(process.env.ENDPOINT_BENCHMARK_ITERATIONS, 20, 1, 200);
const liveWarmIterations = bounded(process.env.ENDPOINT_BENCHMARK_LIVE_WARM_CALLS, 50, 1, 100);
const concurrency = bounded(process.env.ENDPOINT_BENCHMARK_CONCURRENCY, 4, 2, 10);
const requireLiveCatalog = /^(1|true|yes)$/i.test(process.env.REQUIRE_LIVE_CATALOG ?? "");
const thresholds = { warmAverageMs: 100, p99Ms: 3_000 };

const liveArgs = {
  requestText: "비 오는 퇴근길, 머릿속은 복잡하지만 너무 처지지 않게 차분히 정리되는 노래를 틀어줘",
  semanticIntent: {
    current: { valence: 0.28, energy: 0.48, acousticness: 0.58, label: "복잡하고 지친 퇴근길" },
    target: { valence: 0.62, energy: 0.45, acousticness: 0.66, label: "차분하고 또렷한 상태" },
    discoveryTags: ["rainy day", "focus", "indie pop", "calm"],
    excludeTags: ["metal", "sleep"]
  },
  minutes: 20,
  weather: "비 오는 퇴근길",
  activity: "commute",
  preferences: { preferredGenres: ["k-pop"], discovery: "adventurous" }
};

const arrangeArgs = {
  currentMood: "sad",
  targetMood: "hopeful",
  minutes: 20,
  candidateSource: { providerName: "Melon MCP", toolName: "recommend_personalized_songs_by_dj_mallang" },
  candidates: Array.from({ length: 20 }, (_, index) => ({
    providerTrackId: `benchmark-${index + 1}`,
    title: `Benchmark Track ${index + 1}`,
    artist: `Benchmark Artist ${(index % 12) + 1}`,
    durationSec: 170 + (index % 8) * 9,
    originalRank: index + 1,
    moodTags: index < 6 ? ["sad"] : index < 14 ? ["content"] : ["hopeful"],
    personalizationScore: Math.max(0, 1 - index * 0.035),
    liked: index < 3
  }))
};

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const wallStarted = performance.now();
  const samples: Record<ToolName, Record<Phase, Sample[]>> = Object.fromEntries(
    TOOL_NAMES.map((name) => [name, { cold: [], warm: [], concurrent: [] }])
  ) as unknown as Record<ToolName, Record<Phase, Sample[]>>;

  const client = new Client({ name: "mood-transit-endpoint-benchmark", version: "2.3.0" });
  const connectStarted = performance.now();
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const connectMs = performance.now() - connectStarted;

  let liveColdKind = "missing";
  let liveSemanticAudit: SemanticAudit = {
    passed: false,
    matchedSemanticTags: [],
    unmatchedSemanticTags: [],
    reasons: ["cold semantic request was not completed"]
  };
  try {
    const listed = await client.listTools();
    const discovered = listed.tools.map((tool) => tool.name).sort();
    const expected = [...TOOL_NAMES].sort();
    if (JSON.stringify(discovered) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${discovered.join(", ")}`);

    const liveCold = await measure(client, "build_live_mood_journey", liveArgs);
    samples.build_live_mood_journey.cold.push(liveCold.sample);
    liveColdKind = selectionKind(liveCold.result) ?? "missing";
    liveSemanticAudit = auditSemanticResult(liveCold.result, liveArgs.semanticIntent.discoveryTags);

    const arrangeCold = await measure(client, "arrange_candidate_mood_journey", arrangeArgs);
    samples.arrange_candidate_mood_journey.cold.push(arrangeCold.sample);
    const refinementState = arrangeCold.result?.structuredContent?.refinementState;
    if (!refinementState) throw new Error("Arrange result did not provide refinementState");
    const refineArgs = { refinementState, changes: { discoveryDirection: "more_discovery" } };

    const refineCold = await measure(client, "refine_mood_journey", refineArgs);
    samples.refine_mood_journey.cold.push(refineCold.sample);

    for (let index = 0; index < liveWarmIterations; index += 1) {
      samples.build_live_mood_journey.warm.push((await measure(client, "build_live_mood_journey", liveArgs)).sample);
    }
    for (let index = 0; index < iterations; index += 1) {
      samples.arrange_candidate_mood_journey.warm.push((await measure(client, "arrange_candidate_mood_journey", arrangeArgs)).sample);
      samples.refine_mood_journey.warm.push((await measure(client, "refine_mood_journey", refineArgs)).sample);
    }

    for (const [name, args] of [
      ["build_live_mood_journey", liveArgs],
      ["arrange_candidate_mood_journey", arrangeArgs],
      ["refine_mood_journey", refineArgs]
    ] as const) {
      const measured = await Promise.all(Array.from({ length: concurrency }, () => measure(client, name, args)));
      samples[name].concurrent.push(...measured.map((entry) => entry.sample));
    }

    const tools = Object.fromEntries(TOOL_NAMES.map((name) => {
      const all = [...samples[name].cold, ...samples[name].warm, ...samples[name].concurrent];
      const overall = stats(all);
      const warm = stats(samples[name].warm);
      const passed = overall.errors === 0 && overall.successes > 0
        && warm.errors === 0 && warm.successes > 0
        && (warm.averageMs ?? Infinity) <= thresholds.warmAverageMs
        && (overall.p99Ms ?? Infinity) <= thresholds.p99Ms;
      return [name, {
        cold: stats(samples[name].cold),
        warm,
        concurrent: stats(samples[name].concurrent),
        overall,
        passed,
        errors: all.filter((sample) => !sample.ok).map((sample) => sample.error)
      }];
    })) as unknown as Record<ToolName, { passed: boolean }>;

    const liveCatalogPassed = liveColdKind === "public_open_catalog";
    const passed = TOOL_NAMES.every((name) => tools[name].passed)
      && liveSemanticAudit.passed
      && (!requireLiveCatalog || liveCatalogPassed);
    process.stdout.write(`${JSON.stringify({
      endpoint: endpoint.toString(),
      startedAt,
      durationMs: round(performance.now() - wallStarted),
      connectMs: round(connectMs),
      config: { iterations, liveWarmIterations, concurrency, requireLiveCatalog },
      thresholds,
      liveCatalog: { coldSelectionKind: liveColdKind, passed: liveCatalogPassed, semanticAudit: liveSemanticAudit },
      tools,
      passed
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ endpoint: endpoint.toString(), passed: false, fatalError: errorText(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
