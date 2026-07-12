import { describe, expect, it, vi } from "vitest";
import { WeatherService } from "../src/services/weather.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("weather service", () => {
  it("skips geocoding for a known Korean city and caches successful results", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      current: { temperature_2m: 24.5, apparent_temperature: 25.1, weather_code: 0, wind_speed_10m: 8, time: "2026-07-12T10:00" }
    }));
    const service = new WeatherService({ fetchImpl: mockFetch, deadlineMs: 1_200 });
    const first = await service.lookup("Seoul");
    const second = await service.lookup("seoul");
    expect(first).toMatchObject({ city: "Seoul, South Korea", condition: "clear", source: "open-meteo", temperatureC: 24.5 });
    expect(second.source).toBe("cache");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = new URL(mockFetch.mock.calls[0]![0].toString());
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.searchParams.get("latitude")).toBe("37.5665");
  });

  it("uses only fixed Open-Meteo domains when an unknown city needs geocoding", async () => {
    const mockFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ results: [{ latitude: 48.8566, longitude: 2.3522, name: "Paris", country: "France" }] }))
      .mockResolvedValueOnce(jsonResponse({ current: { temperature_2m: 21, weather_code: 2, wind_speed_10m: 9 } }));
    const service = new WeatherService({ fetchImpl: mockFetch });
    await expect(service.lookup("Paris")).resolves.toMatchObject({ city: "Paris, France", source: "open-meteo" });
    const origins = mockFetch.mock.calls.map(([input]) => new URL(input.toString()).origin);
    expect(origins).toEqual(["https://geocoding-api.open-meteo.com", "https://api.open-meteo.com"]);
  });

  it("returns a neutral fallback on upstream failure", async () => {
    const service = new WeatherService({ fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")), deadlineMs: 25 });
    await expect(service.lookup("Busan")).resolves.toMatchObject({ city: "Busan", condition: "unknown", source: "fallback" });
  });

  it("enforces the total deadline when fetch waits for abort", async () => {
    const hangingFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    }));
    const service = new WeatherService({ fetchImpl: hangingFetch, deadlineMs: 30 });
    const started = performance.now();
    const result = await service.lookup("Incheon");
    expect(result.source).toBe("fallback");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("coalesces concurrent lookups for the same normalized city", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockFetch = vi.fn<typeof fetch>(async () => {
      await gate;
      return jsonResponse({ current: { temperature_2m: 22, weather_code: 1, wind_speed_10m: 4 } });
    });
    const service = new WeatherService({ fetchImpl: mockFetch });
    const first = service.lookup(" 서울 ");
    const second = service.lookup("서울");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.source).toBe("open-meteo");
    expect(secondResult).toEqual(firstResult);
  });

  it("expires entries and keeps the cache within its configured LRU bound", async () => {
    let now = 0;
    const mockFetch = vi.fn<typeof fetch>(async () => jsonResponse({
      current: { temperature_2m: 20, weather_code: 0, wind_speed_10m: 3 }
    }));
    const service = new WeatherService({ fetchImpl: mockFetch, cacheTtlMs: 100, cacheMaxEntries: 2, now: () => now });

    await service.lookup("Seoul");
    now = 99;
    expect((await service.lookup("seoul")).source).toBe("cache");
    now = 100;
    expect((await service.lookup("Seoul")).source).toBe("open-meteo");

    await service.lookup("Busan");
    await service.lookup("Incheon");
    await service.lookup("Seoul");
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("returns the neutral fallback when the per-minute upstream budget is exhausted", async () => {
    let now = 1_000;
    const mockFetch = vi.fn<typeof fetch>(async () => jsonResponse({
      current: { temperature_2m: 20, weather_code: 0, wind_speed_10m: 3 }
    }));
    const service = new WeatherService({
      fetchImpl: mockFetch,
      upstreamRequestLimitPerMinute: 2,
      now: () => now
    });

    expect((await service.lookup("Seoul")).source).toBe("open-meteo");
    expect((await service.lookup("Busan")).source).toBe("open-meteo");
    expect(await service.lookup("Incheon")).toMatchObject({ source: "fallback", condition: "unknown" });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    now += 60_001;
    expect((await service.lookup("Incheon")).source).toBe("open-meteo");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
