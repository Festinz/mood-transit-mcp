import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOOL_NAMES = ["build_mood_journey", "build_weather_journey", "refine_mood_journey"] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type SamplePhase = "cold" | "warm" | "concurrent";

interface ToolResultLike {
  isError?: boolean;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
}

interface ToolSchemaLike {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface LatencySample {
  ms: number;
  ok: boolean;
  error?: string;
  weatherSource?: string;
}

interface MeasuredCall {
  sample: LatencySample;
  result?: ToolResultLike;
}

interface LatencyStats {
  count: number;
  successes: number;
  errors: number;
  averageMs: number | null;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8000/mcp");
if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
  throw new Error("MCP_URL must use http:// or https://");
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function environmentFlag(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name] ?? "");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1));
  return round(sorted[index] ?? 0);
}

function summarize(samples: readonly LatencySample[]): LatencyStats {
  const successful = samples.filter((sample) => sample.ok).map((sample) => sample.ms).sort((a, b) => a - b);
  const average = successful.length === 0 ? null : successful.reduce((sum, value) => sum + value, 0) / successful.length;
  return {
    count: samples.length,
    successes: successful.length,
    errors: samples.length - successful.length,
    averageMs: average === null ? null : round(average),
    minMs: successful.length === 0 ? null : round(successful[0] ?? 0),
    p50Ms: percentile(successful, 0.5),
    p95Ms: percentile(successful, 0.95),
    p99Ms: percentile(successful, 0.99),
    maxMs: successful.length === 0 ? null : round(successful.at(-1) ?? 0)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultError(result: ToolResultLike): string {
  const serialized = JSON.stringify(result.content ?? "Tool returned isError");
  return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
}

function weatherSource(result: ToolResultLike | undefined): string | undefined {
  const weather = result?.structuredContent?.weather;
  if (typeof weather !== "object" || weather === null || !("source" in weather)) return undefined;
  return typeof weather.source === "string" ? weather.source : undefined;
}

function previousTrackIds(result: ToolResultLike | undefined): string[] {
  const value = result?.structuredContent?.trackIdsByPhase;
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((entry) => Array.isArray(entry) ? entry.filter((id): id is string => typeof id === "string") : []);
}

let clientSequence = 0;
async function connectClient(label: string): Promise<{ client: Client; connectMs: number }> {
  const client = new Client({ name: `mood-transit-endpoint-benchmark-${label}-${++clientSequence}`, version: "1.0.0" });
  const started = performance.now();
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    return { client, connectMs: performance.now() - started };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function measureCall(client: Client, tool: ToolName, args: Record<string, unknown>): Promise<MeasuredCall> {
  const started = performance.now();
  try {
    const result = await client.callTool({ name: tool, arguments: args }) as ToolResultLike;
    const ms = performance.now() - started;
    if (result.isError === true) {
      return { sample: { ms, ok: false, error: resultError(result), ...(weatherSource(result) ? { weatherSource: weatherSource(result) } : {}) }, result };
    }
    const source = weatherSource(result);
    return { sample: { ms, ok: true, ...(source ? { weatherSource: source } : {}) }, result };
  } catch (error) {
    return { sample: { ms: performance.now() - started, ok: false, error: errorMessage(error) } };
  }
}

async function freshCall(tool: ToolName, args: Record<string, unknown>): Promise<MeasuredCall & { connectMs: number; totalMs: number }> {
  const totalStarted = performance.now();
  const { client, connectMs } = await connectClient(`cold-${tool}`);
  try {
    const measured = await measureCall(client, tool, args);
    return { ...measured, connectMs, totalMs: performance.now() - totalStarted };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function refineArguments(tool: ToolSchemaLike, ids: readonly string[]): Record<string, unknown> {
  const properties = tool.inputSchema?.properties ?? {};
  const args: Record<string, unknown> = { previousTrackIds: [...ids], feedback: "more_familiar" };
  const assignWhenDeclared = (key: string, value: unknown): void => {
    if (key in properties) args[key] = value;
  };

  assignWhenDeclared("previousCurrentMood", "sad");
  assignWhenDeclared("currentMood", "sad");
  assignWhenDeclared("previousTargetMood", "hopeful");
  assignWhenDeclared("targetMood", "hopeful");
  assignWhenDeclared("previousMinutes", 20);
  assignWhenDeclared("previousRequestedMinutes", 20);
  assignWhenDeclared("requestedMinutes", 20);
  assignWhenDeclared("minutes", 20);

  const missing = (tool.inputSchema?.required ?? []).filter((key) => !(key in args));
  if (missing.length > 0) throw new Error(`Cannot construct refine input; unsupported required fields: ${missing.join(", ")}`);
  return args;
}

const warmIterations = boundedInteger(process.env.ENDPOINT_BENCHMARK_ITERATIONS, 20, 1, 200);
const concurrency = boundedInteger(process.env.ENDPOINT_BENCHMARK_CONCURRENCY, 4, 2, 10);
// Once the single cold call has primed the in-memory cache, these calls do not
// consume additional Open-Meteo quota. A larger warm sample keeps one cold TLS
// handshake from distorting the service's representative average latency.
const weatherWarmCalls = boundedInteger(process.env.ENDPOINT_BENCHMARK_WEATHER_WARM_CALLS, 30, 0, 100);
const requireLiveWeather = environmentFlag("REQUIRE_LIVE_WEATHER");
const city = (process.env.ENDPOINT_BENCHMARK_CITY ?? "Seoul").trim() || "Seoul";
const averageThresholdMs = 100;
const p99ThresholdMs = 3_000;

const buildArgs = {
  currentMood: "sad",
  targetMood: "hopeful",
  weather: "rain",
  activity: "commute",
  minutes: 20
};
const weatherArgs = {
  city,
  currentMood: "tired",
  targetMood: "focused",
  activity: "work",
  minutes: 15,
  instrumentalOnly: true
};

const samples: Record<ToolName, Record<SamplePhase, LatencySample[]>> = {
  build_mood_journey: { cold: [], warm: [], concurrent: [] },
  build_weather_journey: { cold: [], warm: [], concurrent: [] },
  refine_mood_journey: { cold: [], warm: [], concurrent: [] }
};
const connectionSamples: number[] = [];
const concurrentBatches: Array<{ tool: ToolName; size: number; wallMs: number; skipped?: string }> = [];

async function runConcurrent(client: Client, tool: ToolName, args: Record<string, unknown>, size: number): Promise<void> {
  const started = performance.now();
  const measured = await Promise.all(Array.from({ length: size }, () => measureCall(client, tool, args)));
  samples[tool].concurrent.push(...measured.map((entry) => entry.sample));
  concurrentBatches.push({ tool, size, wallMs: round(performance.now() - started) });
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const benchmarkStarted = performance.now();

  const discoveryConnection = await connectClient("discovery");
  connectionSamples.push(discoveryConnection.connectMs);
  let listedTools: ToolSchemaLike[];
  try {
    const listed = await discoveryConnection.client.listTools();
    listedTools = listed.tools as ToolSchemaLike[];
  } finally {
    await discoveryConnection.client.close().catch(() => undefined);
  }

  const discoveredNames = listedTools.map((tool) => tool.name);
  const missingTools = TOOL_NAMES.filter((name) => !discoveredNames.includes(name));
  if (missingTools.length > 0) throw new Error(`Endpoint is missing required tools: ${missingTools.join(", ")}`);

  const coldBuild = await freshCall("build_mood_journey", buildArgs);
  connectionSamples.push(coldBuild.connectMs);
  samples.build_mood_journey.cold.push(coldBuild.sample);
  const ids = previousTrackIds(coldBuild.result);
  if (ids.length < 3) throw new Error("build_mood_journey did not return at least three structured track IDs");

  const refineTool = listedTools.find((tool) => tool.name === "refine_mood_journey");
  if (!refineTool) throw new Error("refine_mood_journey schema was not discoverable");
  const refineArgs = refineArguments(refineTool, ids);

  const coldRefine = await freshCall("refine_mood_journey", refineArgs);
  connectionSamples.push(coldRefine.connectMs);
  samples.refine_mood_journey.cold.push(coldRefine.sample);

  const coldWeather = await freshCall("build_weather_journey", weatherArgs);
  connectionSamples.push(coldWeather.connectMs);
  samples.build_weather_journey.cold.push(coldWeather.sample);
  const coldWeatherSource = weatherSource(coldWeather.result) ?? "missing";
  const weatherCachePrimed = coldWeather.sample.ok && (coldWeatherSource === "open-meteo" || coldWeatherSource === "cache");

  const warmConnection = await connectClient("warm");
  connectionSamples.push(warmConnection.connectMs);
  const warmWeatherSources: string[] = [];
  let weatherCacheConfirmed = false;
  try {
    for (let index = 0; index < warmIterations; index += 1) {
      samples.build_mood_journey.warm.push((await measureCall(warmConnection.client, "build_mood_journey", buildArgs)).sample);
      samples.refine_mood_journey.warm.push((await measureCall(warmConnection.client, "refine_mood_journey", refineArgs)).sample);
    }

    if (weatherCachePrimed) {
      for (let index = 0; index < weatherWarmCalls; index += 1) {
        const measured = await measureCall(warmConnection.client, "build_weather_journey", weatherArgs);
        samples.build_weather_journey.warm.push(measured.sample);
        const source = weatherSource(measured.result) ?? "missing";
        warmWeatherSources.push(source);
        if (source !== "cache") break;
      }
      weatherCacheConfirmed = warmWeatherSources.length === weatherWarmCalls && weatherWarmCalls > 0 && warmWeatherSources.every((source) => source === "cache");
    }

    await runConcurrent(warmConnection.client, "build_mood_journey", buildArgs, concurrency);
    await runConcurrent(warmConnection.client, "refine_mood_journey", refineArgs, concurrency);
    if (weatherCacheConfirmed) {
      await runConcurrent(warmConnection.client, "build_weather_journey", weatherArgs, concurrency);
    } else {
      concurrentBatches.push({ tool: "build_weather_journey", size: 0, wallMs: 0, skipped: "a successful cache was not confirmed by warm calls; extra upstream calls were suppressed" });
    }
  } finally {
    await warmConnection.client.close().catch(() => undefined);
  }

  const tools = Object.fromEntries(TOOL_NAMES.map((tool) => {
    const combined = [...samples[tool].cold, ...samples[tool].warm, ...samples[tool].concurrent];
    const overall = summarize(combined);
    const latencyPassed = overall.errors === 0 && overall.successes > 0 &&
      (overall.averageMs ?? Number.POSITIVE_INFINITY) <= averageThresholdMs &&
      (overall.p99Ms ?? Number.POSITIVE_INFINITY) <= p99ThresholdMs;
    return [tool, {
      cold: summarize(samples[tool].cold),
      warm: summarize(samples[tool].warm),
      concurrent: summarize(samples[tool].concurrent),
      overall,
      latencyPassed,
      errors: combined.filter((sample) => !sample.ok).map((sample) => sample.error ?? "unknown error")
    }];
  })) as Record<ToolName, {
    cold: LatencyStats;
    warm: LatencyStats;
    concurrent: LatencyStats;
    overall: LatencyStats;
    latencyPassed: boolean;
    errors: string[];
  }>;

  const liveWeatherPassed = coldWeatherSource === "open-meteo" || coldWeatherSource === "cache";
  const passed = TOOL_NAMES.every((tool) => tools[tool].latencyPassed) && (!requireLiveWeather || liveWeatherPassed);
  const report = {
    endpoint: endpoint.toString(),
    startedAt,
    durationMs: round(performance.now() - benchmarkStarted),
    config: {
      warmIterationsPerLocalTool: warmIterations,
      concurrentCallsPerLocalTool: concurrency,
      weatherWarmCallsRequested: weatherWarmCalls,
      requireLiveWeather,
      city
    },
    discoveredTools: discoveredNames,
    thresholdsMs: { average: averageThresholdMs, p99: p99ThresholdMs },
    connection: summarize(connectionSamples.map((ms) => ({ ms, ok: true }))),
    coldTotalsMs: {
      build_mood_journey: round(coldBuild.totalMs),
      refine_mood_journey: round(coldRefine.totalMs),
      build_weather_journey: round(coldWeather.totalMs)
    },
    tools,
    concurrentBatches,
    weather: {
      coldSource: coldWeatherSource,
      cachePrimed: weatherCachePrimed,
      cacheConfirmedByWarmCalls: weatherCacheConfirmed,
      warmSources: warmWeatherSources,
      warmCallsSkipped: !weatherCachePrimed || weatherWarmCalls === 0,
      concurrentCallsSkipped: !weatherCacheConfirmed,
      liveWeatherPassed
    },
    passed
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    endpoint: endpoint.toString(),
    passed: false,
    fatalError: errorMessage(error)
  }, null, 2)}\n`);
  process.exitCode = 1;
});
