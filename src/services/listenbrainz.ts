import type { ExternalMusicCandidate } from "../domain/liveTypes.js";

const LISTENBRAINZ_API_ORIGIN = "https://api.listenbrainz.org";
const LISTENBRAINZ_WEB_ORIGIN = "https://listenbrainz.org";
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 64;
const MAX_CANDIDATES = 50;
const MAX_METADATA_LOOKUPS = 80;

export const LISTENBRAINZ_ATTRIBUTION =
  "Recommendations from [ListenBrainz](https://listenbrainz.org/) (listen data CC0); recording metadata from [MusicBrainz](https://musicbrainz.org/) (MetaBrainz Foundation).";

export type ListenBrainzErrorCode =
  | "INVALID_INPUT"
  | "DEADLINE_EXCEEDED"
  | "RATE_LIMITED"
  | "UPSTREAM_NETWORK"
  | "UPSTREAM_HTTP"
  | "UPSTREAM_REDIRECT"
  | "INVALID_RESPONSE";

export class ListenBrainzServiceError extends Error {
  readonly code: ListenBrainzErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: ListenBrainzErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; status?: number; retryAfterMs?: number } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ListenBrainzServiceError";
    this.code = code;
    this.retryable = options.retryable ?? code !== "INVALID_INPUT";
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ListenBrainzCandidateQuery {
  /** MusicBrainz/ListenBrainz tags such as `k-pop`, `sad`, or `hopeful`. */
  tags?: readonly string[];
  tagOperator?: "AND" | "OR";
  /** Optional MusicBrainz artist UUID used by ListenBrainz artist radio. */
  seedArtistMbid?: string;
  artistMode?: "easy" | "medium" | "hard";
  count?: number;
  popularityMin?: number;
  popularityMax?: number;
  maxSimilarArtists?: number;
  maxRecordingsPerArtist?: number;
}

export interface ListenBrainzCandidateResult {
  /** `[]` is a valid successful response with no matching candidates; upstream failures throw. */
  candidates: ExternalMusicCandidate[];
  source: "listenbrainz-live" | "listenbrainz-cache";
  attribution: typeof LISTENBRAINZ_ATTRIBUTION;
  fetchedAt: string;
}

export interface ListenBrainzServiceOptions {
  fetchImpl?: typeof fetch;
  /** Total budget across radio discovery and the batch metadata request. */
  deadlineMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  userAgent?: string;
  now?: () => number;
}

interface NormalizedQuery {
  tags: string[];
  tagOperator: "AND" | "OR";
  seedArtistMbid?: string;
  artistMode: "easy" | "medium" | "hard";
  count: number;
  popularityMin: number;
  popularityMax: number;
  maxSimilarArtists: number;
  maxRecordingsPerArtist: number;
}

interface CacheEntry {
  expiresAt: number;
  value: ListenBrainzCandidateResult;
}

interface DiscoveryItem {
  recordingMbid: string;
  tagPercent?: number;
  tagCount?: number;
  artistListenCount?: number;
  artistMbid?: string;
}

interface MetadataTag {
  tag?: unknown;
  genre_mbid?: unknown;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function requireInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || (resolved as number) < min || (resolved as number) > max) {
    throw new ListenBrainzServiceError("INVALID_INPUT", `${name} must be an integer from ${min} to ${max}`);
  }
  return resolved as number;
}

function requirePercent(value: unknown, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved < 0 || resolved > 100) {
    throw new ListenBrainzServiceError("INVALID_INPUT", `${name} must be from 0 to 100`);
  }
  return resolved;
}

function cleanInputTag(value: unknown): string {
  if (typeof value !== "string") {
    throw new ListenBrainzServiceError("INVALID_INPUT", "Each ListenBrainz tag must be a string");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ListenBrainzServiceError(
      "INVALID_INPUT",
      `Each ListenBrainz tag must contain 1 to ${MAX_TAG_LENGTH} printable characters`
    );
  }
  const tag = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  if (tag.length < 1 || tag.length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/.test(tag)) {
    throw new ListenBrainzServiceError(
      "INVALID_INPUT",
      `Each ListenBrainz tag must contain 1 to ${MAX_TAG_LENGTH} printable characters`
    );
  }
  return tag;
}

function cleanExternalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, maxLength);
}

function validMbid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase("en");
  return MBID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeQuery(input: ListenBrainzCandidateQuery): NormalizedQuery {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ListenBrainzServiceError("INVALID_INPUT", "ListenBrainz query must be an object");
  }
  const inputTags = input.tags ?? [];
  if (!Array.isArray(inputTags) || inputTags.length > MAX_TAGS) {
    throw new ListenBrainzServiceError("INVALID_INPUT", `tags must contain at most ${MAX_TAGS} items`);
  }
  const seenTags = new Set<string>();
  const tags: string[] = [];
  for (const inputTag of inputTags) {
    const tag = cleanInputTag(inputTag);
    if (!seenTags.has(tag)) {
      seenTags.add(tag);
      tags.push(tag);
    }
  }
  tags.sort((left, right) => left.localeCompare(right, "en"));

  let seedArtistMbid: string | undefined;
  if (input.seedArtistMbid !== undefined) {
    seedArtistMbid = validMbid(input.seedArtistMbid);
    if (!seedArtistMbid) {
      throw new ListenBrainzServiceError("INVALID_INPUT", "seedArtistMbid must be a MusicBrainz UUID");
    }
  }
  if (tags.length === 0 && seedArtistMbid === undefined) {
    throw new ListenBrainzServiceError("INVALID_INPUT", "At least one tag or seedArtistMbid is required");
  }

  const tagOperator = input.tagOperator ?? "OR";
  if (tagOperator !== "AND" && tagOperator !== "OR") {
    throw new ListenBrainzServiceError("INVALID_INPUT", "tagOperator must be AND or OR");
  }
  const artistMode = input.artistMode ?? "medium";
  if (artistMode !== "easy" && artistMode !== "medium" && artistMode !== "hard") {
    throw new ListenBrainzServiceError("INVALID_INPUT", "artistMode must be easy, medium, or hard");
  }

  const popularityMin = requirePercent(input.popularityMin, 0, "popularityMin");
  const popularityMax = requirePercent(input.popularityMax, 100, "popularityMax");
  if (popularityMin > popularityMax) {
    throw new ListenBrainzServiceError("INVALID_INPUT", "popularityMin must not exceed popularityMax");
  }

  return {
    tags,
    tagOperator,
    ...(seedArtistMbid === undefined ? {} : { seedArtistMbid }),
    artistMode,
    count: requireInteger(input.count, 24, 1, MAX_CANDIDATES, "count"),
    popularityMin,
    popularityMax,
    maxSimilarArtists: requireInteger(input.maxSimilarArtists, 8, 1, 20, "maxSimilarArtists"),
    maxRecordingsPerArtist: requireInteger(input.maxRecordingsPerArtist, 3, 1, 10, "maxRecordingsPerArtist")
  };
}

function cloneCandidate(candidate: ExternalMusicCandidate): ExternalMusicCandidate {
  return {
    ...candidate,
    ...(candidate.artistMbids === undefined ? {} : { artistMbids: [...candidate.artistMbids] }),
    ...(candidate.tags === undefined ? {} : { tags: [...candidate.tags] }),
    ...(candidate.genres === undefined ? {} : { genres: [...candidate.genres] })
  };
}

function cloneResult(result: ListenBrainzCandidateResult, source = result.source): ListenBrainzCandidateResult {
  return {
    ...result,
    source,
    candidates: result.candidates.map(cloneCandidate)
  };
}

function discoveryPopularity(item: DiscoveryItem): number {
  const tagPopularity = item.tagPercent === undefined ? 0 : clamp(item.tagPercent, 0, 100);
  const artistPopularity = item.artistListenCount === undefined
    ? 0
    : clamp(Math.log10(item.artistListenCount + 1) * 20, 0, 100);
  return Math.round(Math.max(tagPopularity, artistPopularity) * 10) / 10;
}

function mergeDiscovery(target: Map<string, DiscoveryItem>, incoming: DiscoveryItem): void {
  const current = target.get(incoming.recordingMbid);
  if (!current) {
    target.set(incoming.recordingMbid, incoming);
    return;
  }
  target.set(incoming.recordingMbid, {
    recordingMbid: incoming.recordingMbid,
    tagPercent: Math.max(current.tagPercent ?? 0, incoming.tagPercent ?? 0) || undefined,
    tagCount: Math.max(current.tagCount ?? 0, incoming.tagCount ?? 0) || undefined,
    artistListenCount: Math.max(current.artistListenCount ?? 0, incoming.artistListenCount ?? 0) || undefined,
    artistMbid: current.artistMbid ?? incoming.artistMbid
  });
}

function parseTagRadio(value: unknown): DiscoveryItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ListenBrainzServiceError("INVALID_RESPONSE", "ListenBrainz tag radio returned an invalid payload");
  }
  const result: DiscoveryItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const recordingMbid = validMbid(raw.recording_mbid);
    if (!recordingMbid) continue;
    const percent = finiteNumber(raw.percent);
    const tagCount = finiteNumber(raw.tag_count);
    result.push({
      recordingMbid,
      ...(percent === undefined ? {} : { tagPercent: clamp(percent, 0, 100) }),
      ...(tagCount === undefined ? {} : { tagCount: Math.max(0, Math.round(tagCount)) })
    });
  }
  if (value.length > 0 && result.length === 0) {
    throw new ListenBrainzServiceError("INVALID_RESPONSE", "ListenBrainz tag radio returned no valid recording IDs");
  }
  return result;
}

function parseArtistRadio(value: unknown): DiscoveryItem[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    throw new ListenBrainzServiceError("INVALID_RESPONSE", "ListenBrainz artist radio returned an invalid payload");
  }
  const result: DiscoveryItem[] = [];
  let rawEntryCount = 0;
  for (const rawItems of Object.values(value)) {
    if (!Array.isArray(rawItems)) continue;
    rawEntryCount += rawItems.length;
    for (const raw of rawItems) {
      if (!isRecord(raw)) continue;
      const recordingMbid = validMbid(raw.recording_mbid);
      if (!recordingMbid) continue;
      const artistMbid = validMbid(raw.similar_artist_mbid);
      const listenCount = finiteNumber(raw.total_listen_count);
      result.push({
        recordingMbid,
        ...(artistMbid === undefined ? {} : { artistMbid }),
        ...(listenCount === undefined ? {} : { artistListenCount: Math.max(0, Math.round(listenCount)) })
      });
    }
  }
  if (rawEntryCount > 0 && result.length === 0) {
    throw new ListenBrainzServiceError("INVALID_RESPONSE", "ListenBrainz artist radio returned no valid recording IDs");
  }
  return result;
}

function collectMetadataTags(value: unknown): { tags: string[]; genres: string[] } {
  if (!isRecord(value)) return { tags: [], genres: [] };
  const tagSet = new Set<string>();
  const genreSet = new Set<string>();
  for (const groupName of ["recording", "artist", "release_group"] as const) {
    const group = value[groupName];
    if (!Array.isArray(group)) continue;
    for (const rawEntry of group as MetadataTag[]) {
      const tag = cleanExternalText(rawEntry?.tag, MAX_TAG_LENGTH)?.toLocaleLowerCase("en");
      if (!tag) continue;
      tagSet.add(tag);
      if (validMbid(rawEntry?.genre_mbid)) genreSet.add(tag);
    }
  }
  return { tags: [...tagSet].slice(0, 40), genres: [...genreSet].slice(0, 20) };
}

function firstArtistMbid(artistValue: unknown): string | undefined {
  if (!isRecord(artistValue) || !Array.isArray(artistValue.artists)) return undefined;
  for (const artist of artistValue.artists) {
    if (!isRecord(artist)) continue;
    const mbid = validMbid(artist.artist_mbid);
    if (mbid) return mbid;
  }
  return undefined;
}

function firstIsrc(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const normalized = raw.toUpperCase().replace(/[-\s]/g, "");
    if (ISRC_PATTERN.test(normalized)) return normalized;
  }
  return undefined;
}

function candidateFromMetadata(
  item: DiscoveryItem,
  rawMetadata: unknown,
  currentYear: number
): ExternalMusicCandidate | undefined {
  if (!isRecord(rawMetadata)) return undefined;
  const recording = isRecord(rawMetadata.recording) ? rawMetadata.recording : undefined;
  const artistInfo = isRecord(rawMetadata.artist) ? rawMetadata.artist : undefined;
  const release = isRecord(rawMetadata.release) ? rawMetadata.release : undefined;
  const title = cleanExternalText(recording?.name, 160);
  const artist = cleanExternalText(artistInfo?.name, 120);
  if (!title || !artist) return undefined;

  const lengthMs = finiteNumber(recording?.length);
  const durationSec = lengthMs !== undefined && lengthMs > 0 && lengthMs <= 86_400_000
    ? Math.round(lengthMs / 1_000)
    : undefined;
  const releaseTitle = cleanExternalText(release?.name, 160);
  const rawReleaseYear = finiteNumber(release?.year);
  const dateYear = typeof recording?.first_release_date === "string"
    ? Number.parseInt(recording.first_release_date.slice(0, 4), 10)
    : Number.NaN;
  const releaseYearCandidate = rawReleaseYear ?? dateYear;
  const releaseYear = Number.isInteger(releaseYearCandidate)
    && releaseYearCandidate >= 1000
    && releaseYearCandidate <= currentYear + 1
    ? releaseYearCandidate
    : undefined;
  const { tags, genres } = collectMetadataTags(rawMetadata.tag);
  const instrumental = tags.includes("instrumental")
    || /(?:\binstrumental\b|\binst\.?\b|연주곡)/i.test(title);
  // Artist-level `k-pop`/`korean` tags do not prove the language of a specific recording.
  // A Hangul title is a conservative positive signal; otherwise language remains unknown.
  const inferredKorean = /[\uac00-\ud7a3]/u.test(title);
  const artistMbid = firstArtistMbid(artistInfo) ?? item.artistMbid;
  const isrc = firstIsrc(recording?.isrcs);

  return {
    id: `listenbrainz:${item.recordingMbid}`,
    title,
    artist,
    provider: "listenbrainz",
    providerUrl: `${LISTENBRAINZ_WEB_ORIGIN}/track/${item.recordingMbid}/`,
    recordingMbid: item.recordingMbid,
    ...(durationSec === undefined ? {} : { durationSec }),
    ...(artistMbid === undefined ? {} : { artistMbid }),
    ...(isrc === undefined ? {} : { isrc }),
    ...(releaseTitle === undefined ? {} : { releaseTitle }),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(genres.length === 0 ? {} : { genres }),
    ...(inferredKorean ? { language: "ko" } : {}),
    ...(instrumental ? { instrumental: true } : {}),
    popularity: discoveryPopularity(item)
  };
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const resetIn = Number.parseFloat(headers.get("x-ratelimit-reset-in") ?? "");
  if (Number.isFinite(resetIn) && resetIn >= 0) return Math.ceil(resetIn * 1_000);
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const resetEpoch = Number.parseFloat(headers.get("x-ratelimit-reset") ?? "");
  if (Number.isFinite(resetEpoch) && resetEpoch >= 0) return Math.max(0, Math.ceil(resetEpoch * 1_000 - now));
  return undefined;
}

export class ListenBrainzService {
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ListenBrainzCandidateResult>>();
  private blockedUntil = 0;

  constructor(options: ListenBrainzServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.deadlineMs = options.deadlineMs ?? 2_700;
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1_000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 128;
    this.userAgent = options.userAgent ?? "MoodTransit/2.2 (+https://github.com/Festinz/mood-transit-mcp)";
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0 || this.deadlineMs > 10_000) {
      throw new ListenBrainzServiceError("INVALID_INPUT", "deadlineMs must be from 1 to 10000");
    }
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0 || this.cacheTtlMs > 24 * 60 * 60 * 1_000) {
      throw new ListenBrainzServiceError("INVALID_INPUT", "cacheTtlMs must be from 0 to 86400000");
    }
    if (!Number.isInteger(this.cacheMaxEntries) || this.cacheMaxEntries < 1 || this.cacheMaxEntries > 2_048) {
      throw new ListenBrainzServiceError("INVALID_INPUT", "cacheMaxEntries must be from 1 to 2048");
    }
    if (this.userAgent.length < 10 || this.userAgent.length > 256 || /[\r\n]/.test(this.userAgent)) {
      throw new ListenBrainzServiceError("INVALID_INPUT", "userAgent must be a bounded single-line identifier");
    }
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private getCached(key: string): ListenBrainzCandidateResult | undefined {
    const now = this.now();
    this.pruneCache(now);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return cloneResult(entry.value, "listenbrainz-cache");
  }

  private setCached(key: string, value: ListenBrainzCandidateResult): void {
    const now = this.now();
    this.pruneCache(now);
    this.cache.delete(key);
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { expiresAt: now + this.cacheTtlMs, value: cloneResult(value) });
  }

  private assertAllowedUrl(url: URL): void {
    if (url.protocol !== "https:" || url.origin !== LISTENBRAINZ_API_ORIGIN) {
      throw new ListenBrainzServiceError("INVALID_INPUT", "ListenBrainz upstream URL is not allowed");
    }
  }

  private updateRateLimit(response: Response): void {
    const remaining = Number.parseInt(response.headers.get("x-ratelimit-remaining") ?? "", 10);
    if (!Number.isFinite(remaining)) return;
    if (remaining <= 0) {
      const waitMs = retryAfterMs(response.headers, this.now()) ?? 1_000;
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.min(waitMs, 60_000));
    } else if (this.blockedUntil <= this.now()) {
      this.blockedUntil = 0;
    }
  }

  private async honorRateLimit(deadlineAt: number): Promise<void> {
    const waitMs = this.blockedUntil - this.now();
    if (waitMs <= 0) return;
    const remaining = deadlineAt - this.now();
    if (waitMs + 5 >= remaining) {
      throw new ListenBrainzServiceError("RATE_LIMITED", "ListenBrainz rate-limit window exceeds this request deadline", {
        retryAfterMs: waitMs
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs + 5));
  }

  private async requestJson(url: URL, init: RequestInit, deadlineAt: number): Promise<unknown> {
    this.assertAllowedUrl(url);
    await this.honorRateLimit(deadlineAt);
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) {
      throw new ListenBrainzServiceError("DEADLINE_EXCEEDED", "ListenBrainz total deadline was exceeded");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("ListenBrainz total deadline was exceeded", "TimeoutError")),
      remaining
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
          ...(init.headers ?? {})
        },
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new ListenBrainzServiceError("DEADLINE_EXCEEDED", "ListenBrainz total deadline was exceeded", {
          cause: error
        });
      }
      throw new ListenBrainzServiceError("UPSTREAM_NETWORK", "ListenBrainz request failed", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    this.updateRateLimit(response);
    if (response.redirected) {
      throw new ListenBrainzServiceError("UPSTREAM_REDIRECT", "ListenBrainz attempted to redirect the request");
    }
    if (response.url) {
      let responseOrigin: string;
      try {
        responseOrigin = new URL(response.url).origin;
      } catch {
        throw new ListenBrainzServiceError("UPSTREAM_REDIRECT", "ListenBrainz returned an invalid response URL");
      }
      if (responseOrigin !== LISTENBRAINZ_API_ORIGIN) {
        throw new ListenBrainzServiceError("UPSTREAM_REDIRECT", "ListenBrainz response escaped the allowed origin");
      }
    }
    if (response.status === 429) {
      const waitMs = retryAfterMs(response.headers, this.now()) ?? 1_000;
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.min(waitMs, 60_000));
      throw new ListenBrainzServiceError("RATE_LIMITED", "ListenBrainz rate limit was exceeded", {
        status: 429,
        retryAfterMs: waitMs
      });
    }
    if (response.status === 204) return undefined;
    if (!response.ok) {
      throw new ListenBrainzServiceError("UPSTREAM_HTTP", `ListenBrainz responded with HTTP ${response.status}`, {
        status: response.status
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ListenBrainzServiceError("INVALID_RESPONSE", "ListenBrainz returned invalid JSON", { cause: error });
    }
  }

  private async fetchTagRadio(query: NormalizedQuery, deadlineAt: number): Promise<DiscoveryItem[]> {
    const url = new URL("/1/lb-radio/tags", LISTENBRAINZ_API_ORIGIN);
    for (const tag of query.tags) url.searchParams.append("tag", tag);
    if (query.tags.length > 1) url.searchParams.set("operator", query.tagOperator);
    url.searchParams.set("pop_begin", query.popularityMin.toString());
    url.searchParams.set("pop_end", query.popularityMax.toString());
    url.searchParams.set("count", Math.min(MAX_METADATA_LOOKUPS, query.count * 2).toString());
    return parseTagRadio(await this.requestJson(url, { method: "GET" }, deadlineAt));
  }

  private async fetchArtistRadio(query: NormalizedQuery, deadlineAt: number): Promise<DiscoveryItem[]> {
    const url = new URL(`/1/lb-radio/artist/${query.seedArtistMbid!}`, LISTENBRAINZ_API_ORIGIN);
    url.search = new URLSearchParams({
      mode: query.artistMode,
      max_similar_artists: query.maxSimilarArtists.toString(),
      max_recordings_per_artist: query.maxRecordingsPerArtist.toString(),
      pop_begin: query.popularityMin.toString(),
      pop_end: query.popularityMax.toString()
    }).toString();
    return parseArtistRadio(await this.requestJson(url, { method: "GET" }, deadlineAt));
  }

  private async fetchMetadata(recordingMbids: string[], deadlineAt: number): Promise<JsonRecord> {
    const url = new URL("/1/metadata/recording/", LISTENBRAINZ_API_ORIGIN);
    const value = await this.requestJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recording_mbids: recordingMbids, inc: "artist tag release" })
    }, deadlineAt);
    if (value === undefined) return {};
    if (!isRecord(value)) {
      throw new ListenBrainzServiceError("INVALID_RESPONSE", "ListenBrainz metadata returned an invalid payload");
    }
    return value;
  }

  private async fetchUncached(query: NormalizedQuery, cacheKey: string): Promise<ListenBrainzCandidateResult> {
    const deadlineAt = this.now() + this.deadlineMs;
    const discoveryRequests: Array<Promise<DiscoveryItem[]>> = [];
    if (query.tags.length > 0) discoveryRequests.push(this.fetchTagRadio(query, deadlineAt));
    if (query.seedArtistMbid !== undefined) discoveryRequests.push(this.fetchArtistRadio(query, deadlineAt));

    const discovery = new Map<string, DiscoveryItem>();
    for (const items of await Promise.all(discoveryRequests)) {
      for (const item of items) mergeDiscovery(discovery, item);
    }

    const rankedDiscovery = [...discovery.values()]
      .sort((left, right) => {
        const popularityDifference = discoveryPopularity(right) - discoveryPopularity(left);
        if (popularityDifference !== 0) return popularityDifference;
        return (right.tagCount ?? 0) - (left.tagCount ?? 0);
      })
      .slice(0, Math.min(MAX_METADATA_LOOKUPS, query.count * 2));

    let candidates: ExternalMusicCandidate[] = [];
    if (rankedDiscovery.length > 0) {
      const metadata = await this.fetchMetadata(rankedDiscovery.map((item) => item.recordingMbid), deadlineAt);
      const currentYear = new Date(this.now()).getUTCFullYear();
      candidates = rankedDiscovery
        .map((item) => candidateFromMetadata(item, metadata[item.recordingMbid], currentYear))
        .filter((candidate): candidate is ExternalMusicCandidate => candidate !== undefined)
        .slice(0, query.count);
    }

    const result: ListenBrainzCandidateResult = {
      candidates,
      source: "listenbrainz-live",
      attribution: LISTENBRAINZ_ATTRIBUTION,
      fetchedAt: new Date(this.now()).toISOString()
    };
    this.setCached(cacheKey, result);
    return result;
  }

  async getCandidates(input: ListenBrainzCandidateQuery): Promise<ListenBrainzCandidateResult> {
    const query = normalizeQuery(input);
    const cacheKey = JSON.stringify(query);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const existing = this.inFlight.get(cacheKey);
    if (existing) return cloneResult(await existing);

    const pending = this.fetchUncached(query, cacheKey).finally(() => {
      if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, pending);
    return cloneResult(await pending);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
