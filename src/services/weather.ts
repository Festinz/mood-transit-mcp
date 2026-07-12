import type { WeatherContext, WeatherTag } from "../domain/types.js";

export const OPEN_METEO_ATTRIBUTION = "Weather data by [Open-Meteo](https://open-meteo.com/), adapted and classified by MoodTransit ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).";
const GEOCODING_ORIGIN = "https://geocoding-api.open-meteo.com";
const FORECAST_ORIGIN = "https://api.open-meteo.com";
const ALLOWED_ORIGINS = new Set([GEOCODING_ORIGIN, FORECAST_ORIGIN]);

interface CacheEntry {
  expiresAt: number;
  value: WeatherContext;
}

interface KnownLocation {
  latitude: number;
  longitude: number;
}

const KOREAN_CITY_COORDINATES = new Map<string, KnownLocation>([
  ["서울", { latitude: 37.5665, longitude: 126.978 }],
  ["seoul", { latitude: 37.5665, longitude: 126.978 }],
  ["부산", { latitude: 35.1796, longitude: 129.0756 }],
  ["busan", { latitude: 35.1796, longitude: 129.0756 }],
  ["인천", { latitude: 37.4563, longitude: 126.7052 }],
  ["incheon", { latitude: 37.4563, longitude: 126.7052 }],
  ["대구", { latitude: 35.8714, longitude: 128.6014 }],
  ["daegu", { latitude: 35.8714, longitude: 128.6014 }],
  ["대전", { latitude: 36.3504, longitude: 127.3845 }],
  ["daejeon", { latitude: 36.3504, longitude: 127.3845 }],
  ["광주", { latitude: 35.1595, longitude: 126.8526 }],
  ["gwangju", { latitude: 35.1595, longitude: 126.8526 }],
  ["울산", { latitude: 35.5384, longitude: 129.3114 }],
  ["ulsan", { latitude: 35.5384, longitude: 129.3114 }],
  ["제주", { latitude: 33.4996, longitude: 126.5312 }],
  ["제주시", { latitude: 33.4996, longitude: 126.5312 }],
  ["jeju", { latitude: 33.4996, longitude: 126.5312 }],
  ["jeju city", { latitude: 33.4996, longitude: 126.5312 }]
]);

export interface WeatherServiceOptions {
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  upstreamRequestLimitPerMinute?: number;
  now?: () => number;
}

function assertAllowed(url: URL): void {
  if (url.protocol !== "https:" || !ALLOWED_ORIGINS.has(url.origin)) {
    throw new Error("Weather upstream URL is not allowed");
  }
}

function classifyWeather(code: number, temperatureC: number, windKph: number): WeatherTag {
  if (code >= 71 && code <= 77 || code === 85 || code === 86) return "snow";
  if (code >= 51 && code <= 67 || code >= 80 && code <= 82 || code >= 95) return "rain";
  if (windKph >= 38) return "wind";
  if (temperatureC >= 29) return "hot";
  if (temperatureC <= 3) return "cold";
  if (code === 0) return "clear";
  if (code >= 1 && code <= 3 || code === 45 || code === 48) return "cloudy";
  return "unknown";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class WeatherService {
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly upstreamRequestLimitPerMinute: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<WeatherContext>>();
  private readonly upstreamRequestTimestamps: number[] = [];

  constructor(options: WeatherServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.deadlineMs = options.deadlineMs ?? 2_600;
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1_000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 256;
    this.upstreamRequestLimitPerMinute = options.upstreamRequestLimitPerMinute ?? 100;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0) throw new Error("deadlineMs must be positive");
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) throw new Error("cacheTtlMs must be non-negative");
    if (!Number.isInteger(this.cacheMaxEntries) || this.cacheMaxEntries <= 0) throw new Error("cacheMaxEntries must be a positive integer");
    if (!Number.isInteger(this.upstreamRequestLimitPerMinute) || this.upstreamRequestLimitPerMinute <= 0) {
      throw new Error("upstreamRequestLimitPerMinute must be a positive integer");
    }
  }

  private reserveUpstreamRequest(): void {
    const cutoff = this.now() - 60_000;
    while (this.upstreamRequestTimestamps[0] !== undefined && this.upstreamRequestTimestamps[0] <= cutoff) {
      this.upstreamRequestTimestamps.shift();
    }
    if (this.upstreamRequestTimestamps.length >= this.upstreamRequestLimitPerMinute) {
      throw new Error("Weather upstream request budget exhausted");
    }
    this.upstreamRequestTimestamps.push(this.now());
  }

  private async getJson(url: URL, deadlineAt: number): Promise<unknown> {
    assertAllowed(url);
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw new DOMException("Weather deadline exceeded", "TimeoutError");
    this.reserveUpstreamRequest();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Weather deadline exceeded", "TimeoutError")), remaining);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "MoodTransit/2.1" },
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw new Error(`Weather upstream responded ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private getCached(key: string): WeatherContext | undefined {
    const now = this.now();
    this.pruneCache(now);
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    this.cache.delete(key);
    this.cache.set(key, cached);
    return { ...cached.value, source: "cache" };
  }

  private setCached(key: string, value: WeatherContext): void {
    const now = this.now();
    this.pruneCache(now);
    this.cache.delete(key);
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { expiresAt: now + this.cacheTtlMs, value });
  }

  private async lookupUncached(city: string, key: string): Promise<WeatherContext> {
    const deadlineAt = this.now() + this.deadlineMs;
    try {
      const knownLocation = KOREAN_CITY_COORDINATES.get(key);
      let latitude: number;
      let longitude: number;
      let resolvedName = city;
      let country = knownLocation ? ", South Korea" : "";

      if (knownLocation) {
        ({ latitude, longitude } = knownLocation);
      } else {
        const geocodeUrl = new URL("/v1/search", GEOCODING_ORIGIN);
        geocodeUrl.search = new URLSearchParams({ name: city, count: "1", language: "en", format: "json" }).toString();
        const geocodeJson = await this.getJson(geocodeUrl, deadlineAt) as { results?: unknown[] };
        const place = geocodeJson.results?.[0] as { latitude?: unknown; longitude?: unknown; name?: unknown; country?: unknown } | undefined;
        const geocodedLatitude = finiteNumber(place?.latitude);
        const geocodedLongitude = finiteNumber(place?.longitude);
        if (geocodedLatitude === undefined || geocodedLongitude === undefined) throw new Error("City was not found");
        latitude = geocodedLatitude;
        longitude = geocodedLongitude;
        resolvedName = typeof place?.name === "string" ? place.name : city;
        country = typeof place?.country === "string" ? `, ${place.country}` : "";
      }

      const forecastUrl = new URL("/v1/forecast", FORECAST_ORIGIN);
      forecastUrl.search = new URLSearchParams({
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        timezone: "auto",
        forecast_days: "1"
      }).toString();
      const forecastJson = await this.getJson(forecastUrl, deadlineAt) as { current?: Record<string, unknown> };
      const current = forecastJson.current;
      const temperatureC = finiteNumber(current?.temperature_2m);
      const apparentTemperatureC = finiteNumber(current?.apparent_temperature);
      const weatherCode = finiteNumber(current?.weather_code);
      const windKph = finiteNumber(current?.wind_speed_10m);
      if (temperatureC === undefined || weatherCode === undefined || windKph === undefined) throw new Error("Weather response was incomplete");

      const value: WeatherContext = {
        city: `${resolvedName}${country}`,
        condition: classifyWeather(weatherCode, temperatureC, windKph),
        temperatureC,
        ...(apparentTemperatureC === undefined ? {} : { apparentTemperatureC }),
        windKph,
        source: "open-meteo",
        ...(typeof current?.time === "string" ? { observedAt: current.time } : {})
      };
      this.setCached(key, value);
      return value;
    } catch {
      return {
        city,
        condition: "unknown",
        source: "fallback",
        note: "실시간 날씨 조회가 지연되어 날씨 가중치 없이 여정을 구성했습니다."
      };
    }
  }

  async lookup(cityInput: string): Promise<WeatherContext> {
    const city = cityInput.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (city.length < 1 || city.length > 80) throw new Error("city는 1~80자여야 합니다.");
    const key = city.toLocaleLowerCase("en");
    const cached = this.getCached(key);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.lookupUncached(city, key).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
