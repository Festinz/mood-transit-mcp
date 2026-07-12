import { OPEN_METEO_ATTRIBUTION } from "../services/weather.js";
import { PHASE_META, PHASES } from "../domain/journey.js";
import { MOOD_KOREAN_LABELS } from "../domain/moods.js";
import type { Journey, WeatherContext } from "../domain/types.js";

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
}

function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function formatJourneyResult(journey: Journey, weather?: WeatherContext): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  const lines: string[] = [
    "# MoodTransit(기분환승) 음악 여정",
    "",
    `**${MOOD_KOREAN_LABELS[journey.currentMood]} → ${MOOD_KOREAN_LABELS[journey.targetMood]}** · 요청 ${journey.requestedMinutes}분 · 약 ${journey.estimatedMinutes}분`
  ];

  if (weather) {
    const temperature = weather.temperatureC === undefined ? "" : ` · ${weather.temperatureC.toFixed(1)}°C`;
    const fallback = weather.source === "fallback" ? " · 실시간 조회 실패(중립 가중치 사용)" : "";
    lines.push(`날씨: ${escapeMarkdown(weather.city)} · ${weather.condition}${temperature}${fallback}`);
  } else if (journey.context.weather || journey.context.activity) {
    const context = [
      journey.context.weather ? `날씨 ${escapeMarkdown(journey.context.weather)}` : undefined,
      journey.context.activity ? `활동 ${escapeMarkdown(journey.context.activity)}` : undefined
    ].filter(Boolean).join(" · ");
    lines.push(context);
  }

  for (const phase of PHASES) {
    const meta = PHASE_META[phase];
    lines.push("", `## ${meta.label} — ${meta.koreanLabel}`);
    for (const track of journey.tracks.filter((item) => item.phase === phase)) {
      lines.push(
        "",
        `${track.position}. **${escapeMarkdown(track.title)} — ${escapeMarkdown(track.artist)}** (${durationLabel(track.durationSec)})`,
        `   ${track.reason}`,
        `   [YouTube Music](${track.links.youtubeMusic}) · [${track.links.secondaryLabel}](${track.links.secondary})`
      );
    }
  }

  if (weather) lines.push("", OPEN_METEO_ATTRIBUTION);
  lines.push("", "검색 링크는 재생을 보장하지 않으며, 음원·가사·커버 이미지를 제공하지 않습니다.");

  const phaseTrackIds = Object.fromEntries(PHASES.map((phase) => [phase, journey.tracks.filter((track) => track.phase === phase).map((track) => track.id)]));
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      journeyId: journey.journeyId,
      arc: PHASES,
      currentMood: journey.currentMood,
      targetMood: journey.targetMood,
      requestedMinutes: journey.requestedMinutes,
      estimatedMinutes: journey.estimatedMinutes,
      trackIdsByPhase: phaseTrackIds,
      methodologyNote: "Energy/valence/acousticness/familiarity are editorial estimates for music curation, not official streaming metrics or therapeutic claims.",
      ...(weather ? {
        weather: {
          city: weather.city,
          condition: weather.condition,
          source: weather.source,
          attribution: "Open-Meteo data, adapted and classified by MoodTransit (CC BY 4.0)",
          attributionUrl: "https://open-meteo.com/",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/"
        }
      } : {})
    }
  };
}
