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
  favoriteGenres?: string[];
  avoidArtists?: string[];
  avoidGenres?: string[];
  familiarVsDiscovery?: number;
  languagePreference?: "any" | "korean" | "international" | "instrumental";
  instrumentalOnly?: boolean;
}

export interface LiveJourneyTrack extends ExternalMusicCandidate {
  phase: Phase;
  position: number;
  reason: string;
  score: number;
  inferredMood: CanonicalMood;
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
    activity?: string;
    sourceNote?: string;
  };
  tracks: LiveJourneyTrack[];
}
