import { MOOD_KOREAN_LABELS } from "../domain/moods.js";
import type { CandidateSourceDescriptor, RefinementState } from "../domain/refinement.js";
import type { LiveJourney, LiveJourneyTrack } from "../domain/liveTypes.js";
import type { Phase } from "../domain/types.js";

const PHASES: readonly Phase[] = ["mirror", "bridge", "arrive"];
const PHASE_LABELS: Record<Phase, { en: string; ko: string }> = {
  mirror: { en: "Mirror", ko: "공감" },
  bridge: { en: "Bridge", ko: "전환" },
  arrive: { en: "Arrive", ko: "도착" }
};

export interface LiveFormatOptions {
  refinementState: RefinementState;
  candidateCount: number;
  candidateSource?: CandidateSourceDescriptor;
  liveAttribution?: string;
  weatherAttribution?: string;
  fallbackReason?: string;
  publicSources?: Array<"ListenBrainz" | "MusicBrainz">;
  searchResolution?: {
    requestedArtists: string[];
    requestedTracks: string[];
    matchedArtists: string[];
    matchedTracks: string[];
    artistMatches: Array<{ requestedName: string; name: string; mbid: string }>;
    unresolvedArtists: string[];
    artistSearchStatus: "not_requested" | "ok" | "partial" | "no_match" | "error";
    trackSearchStatus: "not_requested" | "ok" | "no_match" | "error";
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
}

function markdownLink(label: string, url: string): string {
  const destination = url.replace(/[\s<>()\[\]]/gu, (character) => encodeURIComponent(character).replace(/[!'()*]/g, (reserved) => `%${reserved.charCodeAt(0).toString(16).toUpperCase()}`));
  return `[${escapeMarkdown(label)}](<${destination}>)`;
}

function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function trackDuration(track: LiveJourneyTrack): { seconds: number; estimated: boolean } {
  return track.durationSec === undefined
    ? { seconds: 210, estimated: true }
    : { seconds: Math.round(track.durationSec), estimated: false };
}

function selectionScope(journey: LiveJourney, options: LiveFormatOptions): {
  kind: "public_open_catalog" | "provided_candidate_batch" | "curated_fallback";
  candidateCount: number;
  statementKo: string;
} {
  if (journey.candidateSource === "listenbrainz-live") {
    const sourceLabel = options.publicSources?.join("·") ?? "ListenBrainz·MusicBrainz";
    return {
      kind: "public_open_catalog",
      candidateCount: options.candidateCount,
      statementKo: `이번 요청에 사용한 ${sourceLabel} 공개 데이터 ${options.candidateCount}개 후보 중 구성했습니다.`
    };
  }
  if (journey.candidateSource === "curated-fallback") {
    return {
      kind: "curated_fallback",
      candidateCount: options.candidateCount,
      statementKo: `실시간 공개 카탈로그를 사용할 수 없어 검증된 ${options.candidateCount}곡 fallback 후보 중 구성했습니다.`
    };
  }
  const providerName = options.candidateSource?.providerName ?? "외부 음악 도구";
  return {
    kind: "provided_candidate_batch",
    candidateCount: options.candidateCount,
    statementKo: `호출자가 ${providerName} 라벨로 전달한 ${options.candidateCount}개 후보 중 구성했으며 해당 공급자의 전체 카탈로그 조회 결과가 아닙니다.`
  };
}

function linksFor(track: LiveJourneyTrack, candidateSource: LiveJourney["candidateSource"]): Array<{
  label: string;
  url: string;
  type: "provider" | "metadata" | "search";
}> {
  const links: Array<{ label: string; url: string; type: "provider" | "metadata" | "search" }> = [];
  if (track.providerUrl) {
    const hostname = new URL(track.providerUrl).hostname;
    if (candidateSource === "external-candidates") {
      links.push({ label: `전달 링크 (${hostname})`, url: track.providerUrl, type: "provider" });
      return links;
    }
    if (track.provider !== "musicbrainz") {
      links.push({ label: `공개 원본 (${hostname})`, url: track.providerUrl, type: "metadata" });
    }
  }
  if (track.recordingMbid) {
    links.push({
      label: "MusicBrainz 메타데이터",
      url: `https://musicbrainz.org/recording/${encodeURIComponent(track.recordingMbid)}`,
      type: "metadata"
    });
  }
  links.push({ label: "YouTube Music 검색", url: track.links.youtubeMusicSearch, type: "search" });
  links.push({ label: "Melon 검색", url: track.links.melonSearch, type: "search" });
  return links.slice(0, 4);
}

export function formatLiveJourneyResult(journey: LiveJourney, options: LiveFormatOptions): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  const scope = selectionScope(journey, options);
  const providerName = options.candidateSource?.providerName
    ?? (journey.candidateSource === "listenbrainz-live" ? "ListenBrainz" : journey.candidateSource === "curated-fallback" ? "MoodTransit fallback" : "외부 음악 도구");
  const lines = [
    "# MoodTransit(기분환승) 음악 여정",
    "",
    `**${MOOD_KOREAN_LABELS[journey.currentMood]} → ${MOOD_KOREAN_LABELS[journey.targetMood]}** · 요청 ${journey.requestedMinutes}분 · 약 ${journey.estimatedMinutes ?? 0}분`,
    escapeMarkdown(scope.statementKo)
  ];

  if (journey.context.weather || journey.context.desiredVibe || journey.context.activity) {
    lines.push([
      journey.context.weather ? `날씨 ${escapeMarkdown(journey.context.weather)}` : undefined,
      journey.context.desiredVibe ? `원하는 분위기 ${escapeMarkdown(journey.context.desiredVibe)}` : undefined,
      journey.context.activity ? `활동 ${escapeMarkdown(journey.context.activity)}` : undefined
    ].filter(Boolean).join(" · "));
  }

  if (options.searchResolution) {
    const requested = [
      options.searchResolution.requestedArtists.length
        ? `아티스트 ${options.searchResolution.requestedArtists.map(escapeMarkdown).join(", ")}`
        : undefined,
      options.searchResolution.requestedTracks.length
        ? `곡 ${options.searchResolution.requestedTracks.map(escapeMarkdown).join(", ")}`
        : undefined
    ].filter(Boolean).join(" · ");
    const matched = [
      options.searchResolution.artistMatches.length
        ? `확인된 아티스트 ${options.searchResolution.artistMatches.map((match) => `${escapeMarkdown(match.requestedName)}→${escapeMarkdown(match.name)}`).join(", ")}`
        : undefined,
      options.searchResolution.matchedTracks.length
        ? `확인된 곡 ${options.searchResolution.matchedTracks.map(escapeMarkdown).join(", ")}`
        : undefined
    ].filter(Boolean).join(" · ");
    lines.push(`공개 카탈로그 텍스트 검색: ${requested}${matched ? ` → ${matched}` : " → 정확한 일치 없음"}`);
  }

  const stages = PHASES.map((phase) => {
    const phaseTracks = journey.tracks.filter((track) => track.phase === phase);
    lines.push("", `## ${PHASE_LABELS[phase].en} — ${PHASE_LABELS[phase].ko}`);
    const outputTracks = phaseTracks.map((track) => {
      const duration = trackDuration(track);
      const links = linksFor(track, journey.candidateSource);
      lines.push(
        "",
        `${track.position}. **${escapeMarkdown(track.title)} — ${escapeMarkdown(track.artist)}** (${durationLabel(duration.seconds)}${duration.estimated ? ", 추정" : ""})`,
        `   ${track.reason}`,
        `   ${links.map((link) => markdownLink(link.label, link.url)).join(" · ")}`
      );
      const sourceProvider = journey.candidateSource === "external-candidates"
        ? providerName
        : track.provider === "musicbrainz"
          ? "MusicBrainz"
          : track.provider === "listenbrainz"
            ? "ListenBrainz"
            : providerName;
      return {
        trackKey: track.id,
        title: track.title,
        artist: track.artist,
        durationSec: duration.seconds,
        durationEstimated: duration.estimated,
        sourceProvider,
        ...(track.originalRank === undefined ? {} : { originalRank: track.originalRank }),
        inferredMood: track.inferredMood,
        moodSignal: track.moodSignal
      };
    });
    return { stage: phase, labelKo: PHASE_LABELS[phase].ko, tracks: outputTracks };
  });

  const publicSourceSet = new Set(options.publicSources ?? ["ListenBrainz", "MusicBrainz"]);
  const publicSources: Array<Record<string, unknown>> = [
    ...(publicSourceSet.has("ListenBrainz")
      ? [{ name: "ListenBrainz", role: "discovery", url: "https://listenbrainz.org/", noteKo: "기분·장르 태그 기반 후보 발견" }]
      : []),
    ...(publicSourceSet.has("MusicBrainz")
      ? [{ name: "MusicBrainz", role: "discovery_and_metadata", url: "https://musicbrainz.org/", noteKo: "아티스트 별칭·곡명 공개 검색과 곡·길이·태그 메타데이터" }]
      : [])
  ];
  const sources: Array<Record<string, unknown>> = journey.candidateSource === "listenbrainz-live"
      ? publicSources
    : journey.candidateSource === "curated-fallback"
      ? [{ name: "MoodTransit fallback", role: "candidate_source", noteKo: options.fallbackReason ?? "공개 경로 장애·후보 부족·필터 불충족 시에만 사용" }]
      : [{
          name: providerName,
          role: "candidate_source",
          ...(options.candidateSource?.toolName ? { toolName: options.candidateSource.toolName } : {}),
          noteKo: "호출자가 이 공급자 라벨로 전달한 후보만 재배열했으며 라벨의 진위를 서버가 인증하지 않음"
        }];
  if (options.weatherAttribution) {
    sources.push({
      name: "Open-Meteo",
      role: "weather",
      url: "https://open-meteo.com/",
      license: "CC BY 4.0",
      noteKo: "현재 날씨 데이터를 기분환승이 분류·가공"
    });
  }

  const limitations = [
    "YouTube Music·Melon 링크는 검색용이며 재생 가능 여부를 보장하지 않습니다.",
    journey.candidateSource === "listenbrainz-live"
      ? "MusicBrainz는 대규모 커뮤니티 카탈로그이지만 전 세계 모든 발매를 보장하지 않습니다."
      : journey.candidateSource === "curated-fallback"
        ? "이 결과는 실시간 공개 후보가 아니라 장애·후보 부족·필터 불충족 시 사용하는 비상 후보에 한정됩니다."
        : "이 결과는 전달받은 후보 묶음에만 한정되며 공급자 전체 카탈로그 결과가 아닙니다.",
    "3단계 감정 경로와 점수는 기분환승의 편집적 계산이며 공식 음향 특성이나 치료 효과가 아닙니다."
  ];
  if (journey.context.contextMatchMode === "broadened") {
    limitations.push("공개 메타데이터에서 날씨·분위기 태그가 확인된 후보가 3개 미만이어서 감정 경로와 일반 태그까지 범위를 넓혔습니다.");
  }
  if (options.fallbackReason) limitations.push(`실시간 후보 fallback 사유: ${options.fallbackReason}`);
  if (options.searchResolution) {
    if (options.searchResolution.unresolvedArtists.length > 0) {
      limitations.push(`요청한 아티스트의 정확한 공개 카탈로그 일치를 확인하지 못했습니다: ${options.searchResolution.unresolvedArtists.join(", ")}`);
    }
    const unresolvedTracks = options.searchResolution.requestedTracks.filter((requested) => (
      !options.searchResolution!.matchedTracks.some((matched) => matched.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en"))
    ));
    if (unresolvedTracks.length > 0) {
      limitations.push(`요청한 곡명의 정확한 공개 카탈로그 일치를 확인하지 못했습니다: ${unresolvedTracks.join(", ")}`);
    }
  }

  if (options.liveAttribution) lines.push("", options.liveAttribution);
  if (options.weatherAttribution) lines.push("", options.weatherAttribution);
  lines.push("", ...limitations.map((item) => `- ${item}`));

  const estimatedFlags = journey.tracks.map((track) => track.durationSec === undefined);
  const durationBasis = estimatedFlags.every(Boolean)
    ? "estimated"
    : estimatedFlags.some(Boolean)
      ? "mixed"
      : journey.candidateSource === "external-candidates" ? "provider" : "metadata";

  const structuredContent: Record<string, unknown> = {
    status: "ok",
    schemaVersion: "1.0",
    journeyId: journey.journeyId,
    revision: options.refinementState.revision,
    sourceMode: options.refinementState.sourceMode,
    selectionScope: scope,
    currentMood: journey.currentMood,
    targetMood: journey.targetMood,
    requestedMinutes: journey.requestedMinutes,
    estimatedMinutes: journey.estimatedMinutes ?? 0,
    durationBasis,
    context: journey.context,
    stages,
    sources,
    limitations,
    methodologyNoteKo: "3단계 감정 경로와 곡 순서는 기분환승의 편집적 구성입니다. 공급자의 공식 추천 순위나 공식 음향 특성 점수가 아닙니다.",
    ...(options.searchResolution ? { searchResolution: options.searchResolution } : {}),
    refinementState: options.refinementState
  };
  const result: { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } = {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 56 * 1_024) return result;

  const clip = (value: string, maximum: number) => {
    const characters = Array.from(value);
    return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
  };
  const compactLines = [
    "# MoodTransit(기분환승) 음악 여정",
    "",
    `**${MOOD_KOREAN_LABELS[journey.currentMood]} → ${MOOD_KOREAN_LABELS[journey.targetMood]}** · 요청 ${journey.requestedMinutes}분 · 약 ${journey.estimatedMinutes ?? 0}분`,
    escapeMarkdown(scope.statementKo)
  ];
  for (const phase of PHASES) {
    compactLines.push("", `## ${PHASE_LABELS[phase].en} — ${PHASE_LABELS[phase].ko}`);
    for (const track of journey.tracks.filter((candidate) => candidate.phase === phase)) {
      const duration = trackDuration(track);
      compactLines.push(`${track.position}. **${escapeMarkdown(clip(track.title, 80))} — ${escapeMarkdown(clip(track.artist, 60))}** (${durationLabel(duration.seconds)}${duration.estimated ? ", 추정" : ""})`);
    }
  }
  compactLines.push("", "응답 크기 제한을 위해 이 결과에서는 곡별 설명과 링크를 축약했습니다.", ...limitations.map((item) => `- ${item}`));
  const compactStages = stages.map((stage) => ({
    ...stage,
    tracks: stage.tracks.map((track) => ({
      ...track,
      title: clip(track.title, 80),
      artist: clip(track.artist, 60)
    }))
  }));
  return {
    content: [{ type: "text", text: compactLines.join("\n") }],
    structuredContent: { ...structuredContent, stages: compactStages, outputCompacted: true }
  };
}
