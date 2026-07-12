export const CANONICAL_MOODS = [
  "calm",
  "content",
  "sad",
  "anxious",
  "tired",
  "focused",
  "hopeful",
  "joyful",
  "energetic",
  "angry",
  "lonely",
  "romantic"
] as const;

export type CanonicalMood = (typeof CANONICAL_MOODS)[number];
export type Phase = "mirror" | "bridge" | "arrive";
export type TrackLocale = "ko" | "international" | "instrumental";
export type WeatherTag = "clear" | "cloudy" | "rain" | "snow" | "hot" | "cold" | "wind" | "unknown";
export type ActivityTag = "rest" | "walk" | "commute" | "work" | "exercise" | "study" | "sleep";

export interface MoodVector {
  valence: number;
  energy: number;
  acousticness: number;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  year: number;
  locale: TrackLocale;
  instrumental: boolean;
  durationSec: number;
  energy: number;
  valence: number;
  acousticness: number;
  familiarity: number;
  moods: readonly CanonicalMood[];
  weather: readonly WeatherTag[];
  activities: readonly ActivityTag[];
}

export interface JourneyTrack extends Track {
  phase: Phase;
  reason: string;
  position: number;
  links: {
    youtubeMusic: string;
    secondary: string;
    secondaryLabel: "Melon" | "Spotify";
  };
}

export interface Journey {
  journeyId: string;
  currentMood: CanonicalMood;
  targetMood: CanonicalMood;
  requestedMinutes: number;
  estimatedMinutes: number;
  context: JourneyContext;
  tracks: JourneyTrack[];
}

export interface JourneyContext {
    weather?: string;
    activity?: string;
    weatherSource?: "open-meteo" | "cache" | "fallback" | "provided";
    languagePreference?: "any" | "korean" | "international" | "instrumental";
    instrumentalOnly?: boolean;
}

export interface JourneyOptions {
  currentMood: string;
  targetMood: string;
  weather?: string;
  activity?: string;
  minutes: number;
  languagePreference?: "any" | "korean" | "international" | "instrumental";
  instrumentalOnly?: boolean;
  avoidArtists?: string[];
  weatherSource?: "open-meteo" | "cache" | "fallback" | "provided";
  excludedTrackIds?: string[];
  familiarityBias?: number;
}

export interface WeatherContext {
  city: string;
  condition: WeatherTag;
  temperatureC?: number;
  apparentTemperatureC?: number;
  windKph?: number;
  source: "open-meteo" | "cache" | "fallback";
  observedAt?: string;
  note?: string;
}
