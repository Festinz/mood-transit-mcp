import { ListenBrainzService } from "../src/services/listenbrainz.js";

const TWICE_MBID = "8da127cc-c432-418f-b356-ef36210d82ac";
const deadlineMs = Number.parseInt(process.env.LISTENBRAINZ_DEADLINE_MS ?? "2700", 10);
if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000) {
  throw new Error("LISTENBRAINZ_DEADLINE_MS must be an integer from 1 to 10000");
}

interface ObservedCall {
  method: string;
  endpoint: string;
  status: number;
  latencyMs: number;
  rateRemaining?: string;
}

const calls: ObservedCall[] = [];
const trackedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const started = performance.now();
  const response = await fetch(input, init);
  const rateRemaining = response.headers.get("x-ratelimit-remaining") ?? undefined;
  calls.push({
    method: init?.method ?? "GET",
    endpoint: `${url.origin}${url.pathname}`,
    status: response.status,
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
    ...(rateRemaining === undefined ? {} : { rateRemaining })
  });
  return response;
};

const service = new ListenBrainzService({ fetchImpl: trackedFetch, deadlineMs });

async function measured<T>(operation: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
}

function assertCandidateShape(label: string, candidates: Array<{
  title?: unknown;
  artist?: unknown;
  durationSec?: unknown;
  recordingMbid?: unknown;
  tags?: unknown;
}>): void {
  if (candidates.length === 0) throw new Error(`${label} returned no candidates`);
  if (!candidates.every((candidate) => typeof candidate.title === "string" && typeof candidate.artist === "string")) {
    throw new Error(`${label} returned a candidate without title/artist`);
  }
  if (!candidates.some((candidate) => typeof candidate.durationSec === "number")) {
    throw new Error(`${label} returned no duration metadata`);
  }
  if (!candidates.every((candidate) => typeof candidate.recordingMbid === "string")) {
    throw new Error(`${label} returned a candidate without recording MBID`);
  }
  if (!candidates.some((candidate) => Array.isArray(candidate.tags) && candidate.tags.length > 0)) {
    throw new Error(`${label} returned no tag metadata`);
  }
}

const tagRun = await measured(() => service.getCandidates({
  tags: ["k-pop"],
  count: 6,
  popularityMin: 35,
  popularityMax: 100
}));
assertCandidateShape("k-pop tag radio", tagRun.value.candidates);

const artistRun = await measured(() => service.getCandidates({
  seedArtistMbid: TWICE_MBID,
  artistMode: "easy",
  count: 6,
  popularityMin: 35,
  popularityMax: 100,
  maxSimilarArtists: 6,
  maxRecordingsPerArtist: 2
}));
assertCandidateShape("TWICE artist radio", artistRun.value.candidates);

const cachedRun = await measured(() => service.getCandidates({
  tags: ["K-POP"],
  count: 6,
  popularityMin: 35,
  popularityMax: 100
}));
if (cachedRun.value.source !== "listenbrainz-cache") throw new Error("Equivalent tag query did not hit cache");

console.log(JSON.stringify({
  ok: true,
  deadlineMs,
  attribution: tagRun.value.attribution,
  calls,
  tagRadio: {
    source: tagRun.value.source,
    latencyMs: tagRun.latencyMs,
    count: tagRun.value.candidates.length,
    samples: tagRun.value.candidates.slice(0, 3).map((candidate) => ({
      title: candidate.title,
      artist: candidate.artist,
      durationSec: candidate.durationSec,
      recordingMbid: candidate.recordingMbid,
      tags: candidate.tags?.slice(0, 5)
    }))
  },
  artistRadio: {
    source: artistRun.value.source,
    seedArtistMbid: TWICE_MBID,
    latencyMs: artistRun.latencyMs,
    count: artistRun.value.candidates.length,
    samples: artistRun.value.candidates.slice(0, 3).map((candidate) => ({
      title: candidate.title,
      artist: candidate.artist,
      durationSec: candidate.durationSec,
      recordingMbid: candidate.recordingMbid,
      tags: candidate.tags?.slice(0, 5)
    }))
  },
  cache: {
    source: cachedRun.value.source,
    latencyMs: cachedRun.latencyMs,
    count: cachedRun.value.candidates.length
  }
}, null, 2));
