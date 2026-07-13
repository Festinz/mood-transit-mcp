import type { SemanticCoverage, SemanticIntent, SemanticPoint, TasteProfile } from "./liveTypes.js";

export type JourneySourceMode = "live_open_catalog" | "provided_candidates";

export interface CandidateSourceDescriptor {
  providerName: string;
  toolName?: string;
  retrievedAt?: string;
}

export interface JourneyRequestState {
  currentMood: string;
  targetMood: string;
  minutes: number;
  requestText?: string;
  semanticIntent?: SemanticIntent;
  semanticIntentSource?: "host_supplied" | "server_inferred" | "mixed";
  semanticCoverage?: SemanticCoverage;
  weather?: string;
  weatherSource?: "provided" | "open-meteo";
  desiredVibe?: string;
  contextTags?: string[];
  activity?: string;
  tasteProfile?: TasteProfile;
  seedArtistMbid?: string;
}

export interface RefinementState {
  stateVersion: "1" | "2";
  sourceMode: JourneySourceMode;
  journeyId: string;
  revision: number;
  request: JourneyRequestState;
  selectedTrackIds: string[];
  candidateSource?: CandidateSourceDescriptor;
  candidatePoolToken?: string;
}

export interface RefinementChanges {
  moodDirection?: "calmer" | "brighter";
  energyDirection?: "more_energy" | "less_energy";
  discoveryDirection?: "more_familiar" | "more_discovery";
  targetMood?: string;
  requestText?: string;
  targetSemantic?: SemanticPoint;
  discoveryTags?: string[];
  excludeTags?: string[];
  minutes?: number;
  languagePreference?: "any" | "korean" | "international" | "instrumental";
  instrumentalOnly?: boolean;
  excludeTrackIds?: string[];
  avoidArtists?: string[];
  reusePolicy?: "keep_unaffected" | "replace_all";
}
