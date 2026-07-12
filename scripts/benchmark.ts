import { performance } from "node:perf_hooks";
import { buildJourney } from "../src/domain/journey.js";

const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? "1000");
const moods = ["우울", "불안", "피곤", "차분", "happy", "angry"] as const;
const targets = ["calm", "hopeful", "joyful", "focused", "energetic"] as const;

for (let index = 0; index < 50; index += 1) {
  buildJourney({ currentMood: moods[index % moods.length] ?? "content", targetMood: targets[index % targets.length] ?? "hopeful", minutes: 30 });
}

const samples: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const start = performance.now();
  buildJourney({
    currentMood: moods[index % moods.length] ?? "content",
    targetMood: targets[index % targets.length] ?? "hopeful",
    weather: index % 2 === 0 ? "rain" : "clear",
    activity: index % 3 === 0 ? "commute" : "study",
    minutes: 30,
    languagePreference: index % 4 === 0 ? "korean" : "any"
  });
  samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const averageMs = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
const p99Index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1);
const p99Ms = samples[p99Index] ?? 0;
const result = { iterations, averageMs: Number(averageMs.toFixed(3)), p99Ms: Number(p99Ms.toFixed(3)), thresholdsMs: { average: 100, p99: 3000 } };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (averageMs >= 100 || p99Ms >= 3_000) process.exitCode = 1;
