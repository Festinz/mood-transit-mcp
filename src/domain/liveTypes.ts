import type { CanonicalMood, Phase } from "./types.js";

export type MusicProvider = "listenbrainz" | "musicbrainz" | "melon" | "youtube" | "other";

export interface ExternalMusicCandidate {
  id: string;
  title: string;
  artist: string;
  durationSec?: number;
  provider: MusicProvider;
  providerUrl?: string;
  originalRank?: number;
  recordingMbid?: string;
  artistMbid?: string;
  artistMbids?: string[];
  isrc?: string;
  releaseTitle?: string;
  releaseYear?: number;
  tags?: string[];
  genres?: string[];
  language?: string;
  instrumental?: boolean;
  personalizationScore?: number;
  popularity?: number;
  liked?: boolean;
  recentPlayCount?: number;
}

export interface TasteProfile {
  favoriteArtists?: string[];
  resolvedArtistNames?: string[];
  favoriteArtistMbids?: string[];
  favoriteTracks?: string[];
  favoriteGenres?: string[];
  avoidArtists?: string[];
  avoidGenres?: string[];
  artistScope?: "prefer" | "only";
  familiarVsDiscovery?: number;
  languagePreference?: "any" | "korean" | "international" | "instrumental";
  instrumentalOnly?: boolean;
}

/**
 * A continuous interpretation supplied by the MCP host. Canonical moods remain
 * useful as display anchors, while these axes retain nuance from unrestricted
 * natural-language requests.
 */
export interface SemanticPoint {
  label?: string;
  valence: number;
  energy: number;
  acousticness: number;
}

export interface SemanticIntent {
  current?: SemanticPoint;
  target?: SemanticPoint;
  discoveryTags?: string[];
  excludeTags?: string[];
}

export type SemanticCoverage = "full" | "partial" | "canonical_fallback";

export interface LiveJourneyTrack extends ExternalMusicCandidate {
  phase: Phase;
  position: number;
  reason: string;
  score: number;
  inferredMood: CanonicalMood;
  moodSignal: "metadata" | "neutral_default";
  links: {
    youtubeMusicSearch: string;
    melonSearch: string;
  };
}

export interface LiveJourney {
  journeyId: string;
  currentMood: CanonicalMood;
  targetMood: CanonicalMood;
  requestedMinutes: number;
  estimatedMinutes?: number;
  candidateSource: "listenbrainz-live" | "external-candidates" | "curated-fallback";
  context: {
    weather?: string;
    desiredVibe?: string;
    contextTags?: string[];
    contextMatchMode?: "strict" | "broadened" | "not_requested";
    matchedSemanticTags?: string[];
    unmatchedSemanticTags?: string[];
    activity?: string;
    requestText?: string;
    semanticIntent?: SemanticIntent;
    semanticCoverage?: SemanticCoverage;
    sourceNote?: string;
  };
  tracks: LiveJourneyTrack[];
}
