import { performance } from "node:perf_hooks";
import { rankExternalCandidates } from "../src/domain/liveJourney.js";
import type { ExternalMusicCandidate } from "../src/domain/liveTypes.js";
import { CANONICAL_MOODS } from "../src/domain/types.js";

const candidates: ExternalMusicCandidate[] = Array.from({ length: 100 }, (_, index) => ({
  id: `benchmark-${index}`,
  title: `Benchmark Track ${index}`,
  artist: `Benchmark Artist ${index % 24}`,
  durationSec: 155 + (index % 17) * 7,
  provider: index % 2 === 0 ? "melon" : "listenbrainz",
  tags: [CANONICAL_MOODS[index % CANONICAL_MOODS.length] ?? "content"],
  genres: [index % 3 === 0 ? "k-pop" : index % 3 === 1 ? "indie" : "electronic"],
  personalizationScore: (100 - index) / 100,
  originalRank: index + 1,
  liked: index < 8,
  recentPlayCount: index < 20 ? 20 - index : 0
}));

const iterations = 500;
const measurements: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const currentMood = CANONICAL_MOODS[index % CANONICAL_MOODS.length] ?? "content";
  const targetMood = CANONICAL_MOODS[(index * 5 + 3) % CANONICAL_MOODS.length] ?? "hopeful";
  const started = performance.now();
  rankExternalCandidates({
    currentMood,
    targetMood,
    minutes: 30,
    tasteProfile: {
      favoriteGenres: [index % 2 === 0 ? "k-pop" : "indie"],
      familiarVsDiscovery: (index % 10) / 10
    }
  }, candidates);
  measurements.push(performance.now() - started);
}

measurements.sort((a, b) => a - b);
const averageMs = measurements.reduce((sum, value) => sum + value, 0) / measurements.length;
const p99Ms = measurements[Math.ceil(measurements.length * 0.99) - 1] ?? 0;
const report = {
  engine: "provider-agnostic live candidate ranking",
  candidatesPerCall: candidates.length,
  iterations,
  averageMs: Number(averageMs.toFixed(3)),
  p99Ms: Number(p99Ms.toFixed(3)),
  thresholdsMs: { average: 100, p99: 3_000 }
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (averageMs > 100 || p99Ms > 3_000) process.exitCode = 1;
