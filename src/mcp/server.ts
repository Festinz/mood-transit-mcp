import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJourney, refineJourney } from "../domain/journey.js";
import { formatJourneyResult } from "../presentation/format.js";
import { WeatherService } from "../services/weather.js";

export const SERVER_NAME = "mood-transit";
export const SERVER_VERSION = "1.0.0";

const mood = z.string().trim().min(1).max(40).describe("Mood in Korean or English, such as 우울, 차분, sad, or energetic.");
const avoidArtists = z.array(z.string().trim().min(1).max(80)).max(12).optional().describe("Artists to exclude, at most 12.");
const languagePreference = z.enum(["any", "korean", "international", "instrumental"]).optional().describe("Optional catalog language preference.");

const buildMoodSchema = z.object({
  currentMood: mood.describe("The listener's current mood."),
  targetMood: mood.describe("The mood the listener wants to reach."),
  weather: z.string().trim().min(1).max(40).optional().describe("Optional user-provided weather, such as rain or 맑음."),
  activity: z.string().trim().min(1).max(50).optional().describe("Optional activity, such as commute, study, or 산책."),
  minutes: z.number().int().min(10).max(60).describe("Available listening time in whole minutes, 10 to 60."),
  languagePreference,
  instrumentalOnly: z.boolean().optional().describe("When true, return instrumental tracks only."),
  avoidArtists
}).strict();

const buildWeatherSchema = z.object({
  city: z.string().trim().min(1).max(80).describe("City name used only for a current weather lookup."),
  currentMood: mood.describe("The listener's current mood."),
  targetMood: mood.describe("The mood the listener wants to reach."),
  activity: z.string().trim().min(1).max(50).optional().describe("Optional activity, such as commute, study, or 산책."),
  minutes: z.number().int().min(10).max(60).describe("Available listening time in whole minutes, 10 to 60."),
  languagePreference,
  instrumentalOnly: z.boolean().optional().describe("When true, return instrumental tracks only."),
  avoidArtists
}).strict();

const refineSchema = z.object({
  previousTrackIds: z.array(z.string().trim().regex(/^[a-z0-9-]{3,80}$/)).min(1).max(24).describe("Track IDs from a prior MoodTransit result, at most 24."),
  previousCurrentMood: mood.describe("Current mood from the prior MoodTransit result; do not infer it from the final track."),
  previousTargetMood: mood.describe("Target mood from the prior MoodTransit result."),
  previousRequestedMinutes: z.number().int().min(10).max(60).describe("Requested minutes from the prior MoodTransit result, 10 to 60."),
  previousContext: z.object({
    weather: z.string().trim().min(1).max(40).optional().describe("Weather from the prior request."),
    activity: z.string().trim().min(1).max(50).optional().describe("Activity from the prior request."),
    weatherSource: z.enum(["open-meteo", "cache", "fallback", "provided"]).optional().describe("Weather source from the prior result."),
    languagePreference,
    instrumentalOnly: z.boolean().optional().describe("Instrumental-only preference from the prior request.")
  }).strict().optional().describe("Optional weather, activity, language, and instrumental context from the prior journey."),
  feedback: z.enum(["calmer", "brighter", "more_energy", "less_energy", "more_familiar", "more_discovery"]).describe("The single adjustment to apply."),
  targetMood: mood.optional().describe("Optional explicit replacement target mood; otherwise the previous target is preserved or adjusted along the feedback axis."),
  avoidArtists
}).strict();

export const TOOL_DESCRIPTIONS = {
  build_mood_journey: "Builds a deterministic three-stage music transition with MoodTransit(기분환승): Mirror acknowledges the current mood, Bridge shifts it gently, and Arrive lands near the target mood. Uses only curated metadata and user-provided weather, activity, time, language, instrumental, and artist-exclusion preferences. Returns concise Markdown, search links, and compact track IDs; never audio, lyrics, ads, or therapeutic claims.",
  build_weather_journey: "Builds a weather-aware three-stage music transition with MoodTransit(기분환승). Looks up current conditions through Open-Meteo under a strict 2.6-second total deadline, bounded 10-minute cache, upstream request budget, and neutral fallback; known Korean cities skip geocoding. Then applies Mirror, Bridge, and Arrive scoring. Returns attribution, concise Markdown, search links, and compact track IDs. No location is persisted or logged. No therapeutic claim is made.",
  refine_mood_journey: "Refines a prior MoodTransit(기분환승) three-stage music journey from its explicit current mood, target mood, requested time, context, track IDs, and one bounded feedback choice. Excludes prior tracks and requested artists; familiarity or discovery feedback preserves the prior mood arc, while directional feedback adjusts its target along the requested axis. Returns deterministic concise Markdown with search links and compact IDs. This is music curation, not treatment advice."
} as const;

const LOCAL_ANNOTATIONS = {
  title: "Build a three-stage mood journey",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

function errorResult(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  return { isError: true, content: [{ type: "text", text: `여정을 만들지 못했습니다: ${message}` }] };
}

export function createMcpServer(weatherService = new WeatherService()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "MoodTransit(기분환승)" },
    { capabilities: { tools: { listChanged: false } }, instructions: "Creates deterministic three-stage music curation journeys. It does not stream music or provide medical advice." }
  );

  server.registerTool("build_mood_journey", {
    title: "MoodTransit three-stage journey",
    description: TOOL_DESCRIPTIONS.build_mood_journey,
    inputSchema: buildMoodSchema,
    annotations: LOCAL_ANNOTATIONS
  }, async (input) => {
    try {
      return formatJourneyResult(buildJourney({
        currentMood: input.currentMood,
        targetMood: input.targetMood,
        minutes: input.minutes,
        ...(input.weather === undefined ? {} : { weather: input.weather }),
        ...(input.activity === undefined ? {} : { activity: input.activity }),
        ...(input.languagePreference === undefined ? {} : { languagePreference: input.languagePreference }),
        ...(input.instrumentalOnly === undefined ? {} : { instrumentalOnly: input.instrumentalOnly }),
        ...(input.avoidArtists === undefined ? {} : { avoidArtists: input.avoidArtists })
      }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("build_weather_journey", {
    title: "MoodTransit weather-aware journey",
    description: TOOL_DESCRIPTIONS.build_weather_journey,
    inputSchema: buildWeatherSchema,
    annotations: { ...LOCAL_ANNOTATIONS, title: "Build a weather-aware mood journey", openWorldHint: true }
  }, async (input) => {
    try {
      const weather = await weatherService.lookup(input.city);
      const journey = buildJourney({
        currentMood: input.currentMood,
        targetMood: input.targetMood,
        weather: weather.condition,
        weatherSource: weather.source,
        minutes: input.minutes,
        ...(input.activity === undefined ? {} : { activity: input.activity }),
        ...(input.languagePreference === undefined ? {} : { languagePreference: input.languagePreference }),
        ...(input.instrumentalOnly === undefined ? {} : { instrumentalOnly: input.instrumentalOnly }),
        ...(input.avoidArtists === undefined ? {} : { avoidArtists: input.avoidArtists })
      });
      return formatJourneyResult(journey, weather);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("refine_mood_journey", {
    title: "Refine a MoodTransit journey",
    description: TOOL_DESCRIPTIONS.refine_mood_journey,
    inputSchema: refineSchema,
    annotations: { ...LOCAL_ANNOTATIONS, title: "Refine a prior mood journey" }
  }, async (input) => {
    try {
      return formatJourneyResult(refineJourney({
        previousTrackIds: input.previousTrackIds,
        previousCurrentMood: input.previousCurrentMood,
        previousTargetMood: input.previousTargetMood,
        previousRequestedMinutes: input.previousRequestedMinutes,
        ...(input.previousContext === undefined ? {} : { previousContext: input.previousContext }),
        feedback: input.feedback,
        ...(input.targetMood === undefined ? {} : { targetMood: input.targetMood }),
        ...(input.avoidArtists === undefined ? {} : { avoidArtists: input.avoidArtists })
      }));
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}
