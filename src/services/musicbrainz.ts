import type { ExternalMusicCandidate } from "../domain/liveTypes.js";

const MUSICBRAINZ_ORIGIN = "https://musicbrainz.org";
const MUSICBRAINZ_API_PREFIX = "/ws/2/";
const REQUEST_INTERVAL_MS = 1_000;
const MAX_ARTISTS = 5;
const MAX_ARTIST_LENGTH = 120;
const MAX_TRACK_TITLES = 12;
const MAX_TRACK_TITLE_LENGTH = 160;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 64;
const MAX_CANDIDATES = 50;
const MAX_CACHE_TTL_MS = 10 * 60 * 1_000;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

export const MUSICBRAINZ_ATTRIBUTION =
  "Artist and recording metadata from [MusicBrainz](https://musicbrainz.org/) by the MetaBrainz Foundation.";

export type MusicBrainzErrorCode =
  | "INVALID_INPUT"
  | "AMBIGUOUS_ARTIST"
  | "ABORTED"
  | "DEADLINE_EXCEEDED"
  | "RATE_LIMITED"
  | "UPSTREAM_NETWORK"
  | "UPSTREAM_HTTP"
  | "UPSTREAM_REDIRECT"
  | "INVALID_RESPONSE";

export class MusicBrainzServiceError extends Error {
  readonly code: MusicBrainzErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: MusicBrainzErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; status?: number; retryAfterMs?: number } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MusicBrainzServiceError";
    this.code = code;
    this.retryable = options.retryable ?? (
      code === "DEADLINE_EXCEEDED"
      || code === "RATE_LIMITED"
      || code === "UPSTREAM_NETWORK"
      || (code === "UPSTREAM_HTTP" && (options.status ?? 0) >= 500)
    );
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export interface MusicBrainzCandidateQuery {
  /** Artist names or aliases. Each name is resolved to an artist MBID before recordings are searched. */
  artists?: readonly string[];
  /** Pre-resolved MusicBrainz artist UUIDs for an exact recording query. */
  artistMbids?: readonly string[];
  /** Exact recording titles. MusicBrainz search hits are locally checked for exact normalized equality. */
  trackTitles?: readonly string[];
  /** Public recording tags used for broad mood, weather, genre, or vibe discovery. */
  tags?: readonly string[];
  count?: number;
}

export interface MusicBrainzSearchOptions {
  /** Cancels a no-longer-needed hedge before it can occupy the global rate-limit queue. */
  signal?: AbortSignal;
}

export interface MusicBrainzMatchedArtist {
  requestedName: string;
  name: string;
  mbid: string;
  matchedBy: "name" | "alias";
  matchedAlias?: string;
}

export interface MusicBrainzCandidateResult {
  /** `[]` is a valid successful result when MusicBrainz has no exact match. */
  candidates: ExternalMusicCandidate[];
  matchedArtists: MusicBrainzMatchedArtist[];
  matchedArtistNames: string[];
  matchedArtistMbids: string[];
  source: "musicbrainz-live" | "musicbrainz-cache";
  attribution: typeof MUSICBRAINZ_ATTRIBUTION;
  fetchedAt: string;
}

export interface MusicBrainzServiceOptions {
  fetchImpl?: typeof fetch;
  /** Total budget across artist resolution, rate-limit waits, and recording search. */
  deadlineMs?: number;
  /** Defaults to ten minutes and cannot exceed ten minutes. */
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  maxInFlightQueries?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface QueryTerm {
  display: string;
  key: string;
}

interface NormalizedQuery {
  artists: QueryTerm[];
  artistMbids: string[];
  trackTitles: QueryTerm[];
  tags: QueryTerm[];
  count: number;
}

interface ArtistSearchHit {
  mbid: string;
  name: string;
  aliases: string[];
  score: number;
}

interface ParsedRecording {
  candidate: ExternalMusicCandidate;
  artistMbids: string[];
  titleKey: string;
}

interface CacheEntry {
  expiresAt: number;
  value: MusicBrainzCandidateResult;
}

interface InFlightEntry {
  promise: Promise<MusicBrainzCandidateResult>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): never {
  throw new MusicBrainzServiceError("INVALID_INPUT", message, { retryable: false });
}

function deadlineError(message = "MusicBrainz total deadline was exceeded"): MusicBrainzServiceError {
  return new MusicBrainzServiceError("DEADLINE_EXCEEDED", message, { retryable: true });
}

function abortedError(): MusicBrainzServiceError {
  return new MusicBrainzServiceError("ABORTED", "MusicBrainz search was cancelled because another public source already satisfied the request", { retryable: false });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

function normalizeTextKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanInputTerm(value: unknown, maxLength: number, fieldName: string): QueryTerm {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalidInput(`${fieldName} entries must be printable strings from 1 to ${maxLength} characters`);
  }
  const display = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (display.length < 1 || display.length > maxLength) {
    invalidInput(`${fieldName} entries must be printable strings from 1 to ${maxLength} characters`);
  }
  return { display, key: normalizeTextKey(display) };
}

function normalizeTerms(
  value: unknown,
  maxItems: number,
  maxLength: number,
  fieldName: string
): QueryTerm[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    invalidInput(`${fieldName} must contain at most ${maxItems} entries`);
  }
  const unique = new Map<string, QueryTerm>();
  for (const raw of value) {
    const term = cleanInputTerm(raw, maxLength, fieldName);
    if (!unique.has(term.key)) unique.set(term.key, term);
  }
  return [...unique.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeMbids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTISTS) {
    invalidInput(`artistMbids must contain at most ${MAX_ARTISTS} entries`);
  }
  const normalized = value.map((item) => validMbid(item));
  if (normalized.some((item) => item === undefined)) invalidInput("artistMbids must contain MusicBrainz UUIDs");
  return [...new Set(normalized as string[])].sort();
}

function normalizeQuery(input: MusicBrainzCandidateQuery): NormalizedQuery {
  if (!isRecord(input)) invalidInput("MusicBrainz query must be an object");
  const rawInput = input as JsonRecord;
  const artists = normalizeTerms(rawInput.artists, MAX_ARTISTS, MAX_ARTIST_LENGTH, "artists");
  const artistMbids = normalizeMbids(rawInput.artistMbids);
  const trackTitles = normalizeTerms(
    rawInput.trackTitles,
    MAX_TRACK_TITLES,
    MAX_TRACK_TITLE_LENGTH,
    "trackTitles"
  );
  const tags = normalizeTerms(rawInput.tags, MAX_TAGS, MAX_TAG_LENGTH, "tags");
  if (artists.length === 0 && artistMbids.length === 0 && trackTitles.length === 0 && tags.length === 0) {
    invalidInput("At least one artist, artist MBID, track title, or tag is required");
  }
  const rawCount = rawInput.count ?? 24;
  if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1 || rawCount > MAX_CANDIDATES) {
    invalidInput(`count must be an integer from 1 to ${MAX_CANDIDATES}`);
  }
  return { artists, artistMbids, trackTitles, tags, count: rawCount };
}

function cleanExternalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, maxLength);
}

function validMbid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return MBID_PATTERN.test(normalized) ? normalized : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function escapeLucenePhrase(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function parseArtistSearch(value: unknown): ArtistSearchHit[] {
  if (!isRecord(value) || !Array.isArray(value.artists) || value.artists.length > 100) {
    throw new MusicBrainzServiceError(
      "INVALID_RESPONSE",
      "MusicBrainz artist search returned an invalid payload",
      { retryable: false }
    );
  }
  const hits: ArtistSearchHit[] = [];
  for (const raw of value.artists.slice(0, 25)) {
    if (!isRecord(raw)) continue;
    const mbid = validMbid(raw.id);
    const name = cleanExternalText(raw.name, MAX_ARTIST_LENGTH);
    if (!mbid || !name) continue;
    const aliases: string[] = [];
    if (Array.isArray(raw.aliases)) {
      for (const rawAlias of raw.aliases.slice(0, 40)) {
        const alias = isRecord(rawAlias)
          ? cleanExternalText(rawAlias.name, MAX_ARTIST_LENGTH)
          : cleanExternalText(rawAlias, MAX_ARTIST_LENGTH);
        if (alias && !aliases.some((existing) => normalizeTextKey(existing) === normalizeTextKey(alias))) {
          aliases.push(alias);
        }
      }
    }
    hits.push({
      mbid,
      name,
      aliases,
      score: Math.max(0, Math.min(100, finiteNumber(raw.score) ?? 0))
    });
  }
  if (value.artists.length > 0 && hits.length === 0) {
    throw new MusicBrainzServiceError(
      "INVALID_RESPONSE",
      "MusicBrainz artist search returned no usable artist identifiers",
      { retryable: false }
    );
  }
  return hits;
}

function chooseExactArtist(term: QueryTerm, hits: readonly ArtistSearchHit[]): MusicBrainzMatchedArtist | undefined {
  const matches: Array<{
    hit: ArtistSearchHit;
    matchedBy: "name" | "alias";
    matchedAlias?: string;
    matchStrength: number;
  }> = [];
  for (const hit of hits) {
    if (normalizeTextKey(hit.name) === term.key) {
      matches.push({ hit, matchedBy: "name", matchStrength: 2 });
      continue;
    }
    const alias = hit.aliases.find((candidate) => normalizeTextKey(candidate) === term.key);
    if (alias) matches.push({ hit, matchedBy: "alias", matchedAlias: alias, matchStrength: 1 });
  }
  matches.sort((left, right) => {
    const strengthDifference = right.matchStrength - left.matchStrength;
    if (strengthDifference !== 0) return strengthDifference;
    const scoreDifference = right.hit.score - left.hit.score;
    if (scoreDifference !== 0) return scoreDifference;
    return left.hit.mbid.localeCompare(right.hit.mbid);
  });
  const best = matches[0];
  if (!best) return undefined;
  const exactNameMatches = matches.filter((match) => match.matchedBy === "name");
  if (new Set(exactNameMatches.map((match) => match.hit.mbid)).size > 1) {
    const options = exactNameMatches.slice(0, 4).map(({ hit }) => (
      `${hit.name} (${hit.mbid}): ${MUSICBRAINZ_ORIGIN}/artist/${hit.mbid}`
    )).join("; ");
    throw new MusicBrainzServiceError(
      "AMBIGUOUS_ARTIST",
      `MusicBrainz has multiple exact artists named "${term.display}". Options: ${options}. Open an option to identify the intended artist, use a more specific name, or search with the official Melon MCP`,
      { retryable: false }
    );
  }
  const equallyExact = matches.filter((match) => (
    match.matchStrength === best.matchStrength && best.hit.score - match.hit.score <= 5
  ));
  if (new Set(equallyExact.map((match) => match.hit.mbid)).size > 1) {
    throw new MusicBrainzServiceError(
      "AMBIGUOUS_ARTIST",
      `MusicBrainz has multiple equally ranked exact artists for "${term.display}"; use a more specific name or search with the official Melon MCP`,
      { retryable: false }
    );
  }
  return {
    requestedName: term.display,
    name: best.hit.name,
    mbid: best.hit.mbid,
    matchedBy: best.matchedBy,
    ...(best.matchedAlias === undefined ? {} : { matchedAlias: best.matchedAlias })
  };
}

function parseArtistCredit(value: unknown): { display: string; mbids: string[] } | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) return undefined;
  const parts: string[] = [];
  const mbids: string[] = [];
  for (const raw of value.slice(0, 20)) {
    if (!isRecord(raw)) continue;
    const artistRecord = isRecord(raw.artist) ? raw.artist : undefined;
    const creditName = cleanExternalText(raw.name, MAX_ARTIST_LENGTH)
      ?? cleanExternalText(artistRecord?.name, MAX_ARTIST_LENGTH);
    if (!creditName) continue;
    parts.push(creditName);
    const joinPhrase = typeof raw.joinphrase === "string"
      ? raw.joinphrase.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 20)
      : undefined;
    if (joinPhrase) parts.push(joinPhrase);
    const mbid = validMbid(artistRecord?.id);
    if (mbid && !mbids.includes(mbid)) mbids.push(mbid);
  }
  const display = cleanExternalText(parts.join(""), 200);
  return display ? { display, mbids } : undefined;
}

function parseYear(value: unknown, currentYear: number): number | undefined {
  const text = cleanExternalText(value, 32);
  const match = text?.match(/^(\d{4})(?:-|$)/u);
  if (!match) return undefined;
  const year = Number(match[1]);
  return year >= 1000 && year <= currentYear + 1 ? year : undefined;
}

function firstRelease(value: unknown, currentYear: number): { title?: string; year?: number } {
  if (!Array.isArray(value)) return {};
  for (const raw of value.slice(0, 25)) {
    if (!isRecord(raw)) continue;
    const title = cleanExternalText(raw.title, 160);
    const year = parseYear(raw.date, currentYear);
    if (title || year !== undefined) {
      return {
        ...(title === undefined ? {} : { title }),
        ...(year === undefined ? {} : { year })
      };
    }
  }
  return {};
}

function firstIsrc(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== "string") continue;
    const normalized = raw.toUpperCase().replace(/[-\s]/g, "");
    if (ISRC_PATTERN.test(normalized)) return normalized;
  }
  return undefined;
}

function namesFromMetadata(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const raw of value.slice(0, 50)) {
    const name = cleanExternalText(isRecord(raw) ? raw.name : raw, 64)?.toLowerCase();
    if (name) names.add(name);
    if (names.size >= maxItems) break;
  }
  return [...names];
}

function candidateFromRecording(raw: unknown, currentYear: number): ParsedRecording | undefined {
  if (!isRecord(raw)) return undefined;
  const recordingMbid = validMbid(raw.id);
  const title = cleanExternalText(raw.title, MAX_TRACK_TITLE_LENGTH);
  const artistCredit = parseArtistCredit(raw["artist-credit"]);
  if (!recordingMbid || !title || !artistCredit) return undefined;

  const lengthMs = finiteNumber(raw.length);
  const durationSec = lengthMs !== undefined && lengthMs > 0 && lengthMs <= 86_400_000
    ? Math.round(lengthMs / 1_000)
    : undefined;
  const release = firstRelease(raw.releases, currentYear);
  const releaseYear = parseYear(raw["first-release-date"], currentYear) ?? release.year;
  const isrc = firstIsrc(raw.isrcs);
  const tags = namesFromMetadata(raw.tags, 20);
  const genres = namesFromMetadata(raw.genres, 20);
  const instrumental = [...tags, ...genres].includes("instrumental")
    || /(?:\binstrumental\b|\binst\.?\b|연주곡)/iu.test(title);

  const candidate: ExternalMusicCandidate = {
    id: `musicbrainz:${recordingMbid}`,
    title,
    artist: artistCredit.display,
    provider: "musicbrainz",
    providerUrl: `${MUSICBRAINZ_ORIGIN}/recording/${recordingMbid}`,
    recordingMbid,
    ...(artistCredit.mbids[0] === undefined ? {} : { artistMbid: artistCredit.mbids[0] }),
    ...(artistCredit.mbids.length === 0 ? {} : { artistMbids: [...artistCredit.mbids] }),
    ...(durationSec === undefined ? {} : { durationSec }),
    ...(isrc === undefined ? {} : { isrc }),
    ...(release.title === undefined ? {} : { releaseTitle: release.title }),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(genres.length === 0 ? {} : { genres }),
    ...(/[\uac00-\ud7a3]/u.test(title) ? { language: "ko" } : {}),
    ...(instrumental ? { instrumental: true } : {})
  };
  return { candidate, artistMbids: artistCredit.mbids, titleKey: normalizeTextKey(title) };
}

function parseRecordings(
  value: unknown,
  query: NormalizedQuery,
  matchedArtistMbids: ReadonlySet<string>,
  currentYear: number
): ExternalMusicCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.recordings) || value.recordings.length > 200) {
    throw new MusicBrainzServiceError(
      "INVALID_RESPONSE",
      "MusicBrainz recording search returned an invalid payload",
      { retryable: false }
    );
  }
  const requestedTitles = new Set(query.trackTitles.map((term) => term.key));
  const candidates: ExternalMusicCandidate[] = [];
  const seenRecordingMbids = new Set<string>();
  let usableRecordings = 0;
  for (const raw of value.recordings) {
    const parsed = candidateFromRecording(raw, currentYear);
    if (!parsed) continue;
    usableRecordings += 1;
    if (query.trackTitles.length > 0 && !requestedTitles.has(parsed.titleKey)) continue;
    if (
      (query.artists.length > 0 || query.artistMbids.length > 0)
      && !parsed.artistMbids.some((artistMbid) => matchedArtistMbids.has(artistMbid))
    ) continue;
    const recordingMbid = parsed.candidate.recordingMbid!;
    if (seenRecordingMbids.has(recordingMbid)) continue;
    seenRecordingMbids.add(recordingMbid);
    candidates.push(parsed.candidate);
    if (candidates.length >= query.count) break;
  }
  if (value.recordings.length > 0 && usableRecordings === 0) {
    throw new MusicBrainzServiceError(
      "INVALID_RESPONSE",
      "MusicBrainz recording search returned no usable recording metadata",
      { retryable: false }
    );
  }
  return candidates;
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function cloneCandidate(candidate: ExternalMusicCandidate): ExternalMusicCandidate {
  return {
    ...candidate,
    ...(candidate.artistMbids === undefined ? {} : { artistMbids: [...candidate.artistMbids] }),
    ...(candidate.tags === undefined ? {} : { tags: [...candidate.tags] }),
    ...(candidate.genres === undefined ? {} : { genres: [...candidate.genres] })
  };
}

function cloneResult(
  result: MusicBrainzCandidateResult,
  source: MusicBrainzCandidateResult["source"] = result.source
): MusicBrainzCandidateResult {
  return {
    ...result,
    source,
    candidates: result.candidates.map(cloneCandidate),
    matchedArtists: result.matchedArtists.map((artist) => ({ ...artist })),
    matchedArtistNames: [...result.matchedArtistNames],
    matchedArtistMbids: [...result.matchedArtistMbids]
  };
}

export class MusicBrainzService {
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly maxInFlightQueries: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private rateTail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(options: MusicBrainzServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.deadlineMs = options.deadlineMs ?? 7_500;
    this.cacheTtlMs = options.cacheTtlMs ?? MAX_CACHE_TTL_MS;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 128;
    this.maxInFlightQueries = options.maxInFlightQueries ?? 32;
    this.maxResponseBytes = options.maxResponseBytes ?? 512 * 1_024;
    this.userAgent = options.userAgent ?? "MoodTransit/2.3 (+https://github.com/Festinz/mood-transit-mcp)";
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 30_000) {
      invalidInput("deadlineMs must be from 1 to 30000");
    }
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0 || this.cacheTtlMs > MAX_CACHE_TTL_MS) {
      invalidInput(`cacheTtlMs must be from 0 to ${MAX_CACHE_TTL_MS}`);
    }
    if (!Number.isInteger(this.cacheMaxEntries) || this.cacheMaxEntries < 1 || this.cacheMaxEntries > 2_048) {
      invalidInput("cacheMaxEntries must be an integer from 1 to 2048");
    }
    if (!Number.isInteger(this.maxInFlightQueries) || this.maxInFlightQueries < 1 || this.maxInFlightQueries > 256) {
      invalidInput("maxInFlightQueries must be an integer from 1 to 256");
    }
    if (
      !Number.isInteger(this.maxResponseBytes)
      || this.maxResponseBytes < 256
      || this.maxResponseBytes > 2 * 1_024 * 1_024
    ) {
      invalidInput("maxResponseBytes must be an integer from 256 to 2097152");
    }
    if (
      this.userAgent.length < 10
      || this.userAgent.length > 256
      || /[\r\n]/u.test(this.userAgent)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s()]+/u.test(this.userAgent)
      || !/\([^\r\n)]*(?:https?:\/\/[^\s)]+|[^\s()@]+@[^\s()@]+)[^\r\n)]*\)/u.test(this.userAgent)
    ) {
      invalidInput("userAgent must identify the application version and include a contact URL or email");
    }
  }

  private cacheKey(query: NormalizedQuery): string {
    return JSON.stringify({
      artists: query.artists.map((term) => term.key),
      artistMbids: query.artistMbids,
      trackTitles: query.trackTitles.map((term) => term.key),
      tags: query.tags.map((term) => term.key),
      count: query.count
    });
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private getCached(key: string): MusicBrainzCandidateResult | undefined {
    const now = this.now();
    this.pruneCache(now);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return cloneResult(entry.value, "musicbrainz-cache");
  }

  private setCached(key: string, value: MusicBrainzCandidateResult): void {
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

  private assertAllowedRequestUrl(url: URL): void {
    if (
      url.protocol !== "https:"
      || url.origin !== MUSICBRAINZ_ORIGIN
      || url.username !== ""
      || url.password !== ""
      || !url.pathname.startsWith(MUSICBRAINZ_API_PREFIX)
    ) {
      invalidInput("MusicBrainz upstream URL is outside the official API allowlist");
    }
  }

  private responseUrlIsAllowed(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && url.origin === MUSICBRAINZ_ORIGIN
        && url.username === ""
        && url.password === ""
        && url.pathname.startsWith(MUSICBRAINZ_API_PREFIX);
    } catch {
      return false;
    }
  }

  private async awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!signal) return promise;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortedError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async subscribeToInFlight(entry: InFlightEntry, signal?: AbortSignal): Promise<MusicBrainzCandidateResult> {
    throwIfAborted(signal);
    entry.subscribers += 1;
    try {
      return cloneResult(await this.awaitWithAbort(entry.promise, signal));
    } finally {
      entry.subscribers -= 1;
      if (entry.subscribers === 0 && !entry.settled) {
        for (const [key, active] of this.inFlight) {
          if (active === entry) this.inFlight.delete(key);
        }
        entry.controller.abort();
      }
    }
  }

  private async waitForRateTurn(previous: Promise<void>, deadlineAt: number, signal?: AbortSignal): Promise<void> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw deadlineError();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.awaitWithAbort(Promise.race([
        previous,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(deadlineError("MusicBrainz rate-limit queue exceeded the total deadline")), remaining);
        })
      ]), signal);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async runRateLimited<T>(deadlineAt: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.rateTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.rateTail = gate;
    let acquired = false;
    try {
      await this.waitForRateTurn(previous, deadlineAt, signal);
      acquired = true;
      const waitMs = Math.max(0, this.nextRequestAt - this.now());
      if (waitMs > 0) {
        if (waitMs >= deadlineAt - this.now()) {
          throw deadlineError("The required MusicBrainz one-request-per-second wait exceeds the total deadline");
        }
        await this.awaitWithAbort(this.sleep(waitMs), signal);
      }
      throwIfAborted(signal);
      if (this.now() >= deadlineAt) throw deadlineError();
      const requestStartedAt = Math.max(this.now(), this.nextRequestAt);
      this.nextRequestAt = requestStartedAt + REQUEST_INTERVAL_MS;
      return await operation();
    } finally {
      if (acquired) {
        release();
      } else {
        void previous.then(() => release(), () => release());
      }
    }
  }

  private async readBoundedJson(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("+json")) {
      throw new MusicBrainzServiceError(
        "INVALID_RESPONSE",
        "MusicBrainz returned a non-JSON response",
        { retryable: false }
      );
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new MusicBrainzServiceError(
        "INVALID_RESPONSE",
        `MusicBrainz response exceeded the ${this.maxResponseBytes}-byte safety limit`,
        { retryable: false }
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new MusicBrainzServiceError("INVALID_RESPONSE", "MusicBrainz returned an empty response body", {
        retryable: false
      });
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > this.maxResponseBytes) {
        void reader.cancel();
        throw new MusicBrainzServiceError(
          "INVALID_RESPONSE",
          `MusicBrainz response exceeded the ${this.maxResponseBytes}-byte safety limit`,
          { retryable: false }
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new MusicBrainzServiceError("INVALID_RESPONSE", "MusicBrainz returned malformed JSON", {
        cause: error,
        retryable: false
      });
    }
  }

  private async requestJson(url: URL, deadlineAt: number, signal?: AbortSignal): Promise<unknown> {
    this.assertAllowedRequestUrl(url);
    throwIfAborted(signal);
    return this.runRateLimited(deadlineAt, async () => {
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) throw deadlineError();
      const controller = new AbortController();
      const cancelFromCaller = () => controller.abort(abortedError());
      signal?.addEventListener("abort", cancelFromCaller, { once: true });
      const timeout = setTimeout(
        () => controller.abort(new DOMException("MusicBrainz total deadline was exceeded", "TimeoutError")),
        remaining
      );
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": this.userAgent
          },
          redirect: "manual",
          signal: controller.signal
        });
        if (this.now() >= deadlineAt) throw deadlineError();
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new MusicBrainzServiceError(
            "UPSTREAM_REDIRECT",
            "MusicBrainz attempted a redirect; the response was rejected instead of following it",
            { status: response.status, retryable: false }
          );
        }
        if (response.url && !this.responseUrlIsAllowed(response.url)) {
          throw new MusicBrainzServiceError(
            "UPSTREAM_REDIRECT",
            "MusicBrainz response escaped the official API origin allowlist",
            { retryable: false }
          );
        }
        // MusicBrainz documents HTTP 503 as its throttling response; accept 429 as well for intermediaries.
        if (response.status === 429 || response.status === 503) {
          const waitMs = retryAfterMs(response.headers, this.now()) ?? REQUEST_INTERVAL_MS;
          this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + Math.min(waitMs, 60_000));
          throw new MusicBrainzServiceError(
            "RATE_LIMITED",
            "MusicBrainz rate limit was exceeded; retry after the indicated delay",
            { status: response.status, retryAfterMs: waitMs, retryable: true }
          );
        }
        if (!response.ok) {
          const retryAfter = retryAfterMs(response.headers, this.now());
          throw new MusicBrainzServiceError(
            "UPSTREAM_HTTP",
            `MusicBrainz responded with HTTP ${response.status}${response.status >= 500 ? "; retry later" : ""}`,
            {
              status: response.status,
              ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
            }
          );
        }
        return await this.readBoundedJson(response);
      } catch (error) {
        if (error instanceof MusicBrainzServiceError) throw error;
        if (signal?.aborted) throw abortedError();
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw new MusicBrainzServiceError(
            "DEADLINE_EXCEEDED",
            "MusicBrainz total deadline was exceeded",
            { cause: error, retryable: true }
          );
        }
        throw new MusicBrainzServiceError(
          "UPSTREAM_NETWORK",
          "MusicBrainz request failed before a valid response was received; retry later",
          { cause: error, retryable: true }
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancelFromCaller);
      }
    }, signal);
  }

  private async resolveArtist(term: QueryTerm, deadlineAt: number, signal?: AbortSignal): Promise<MusicBrainzMatchedArtist | undefined> {
    const escapedName = escapeLucenePhrase(term.display);
    const url = new URL("/ws/2/artist/", MUSICBRAINZ_ORIGIN);
    url.search = new URLSearchParams({
      query: `(artist:"${escapedName}" OR alias:"${escapedName}")`,
      fmt: "json",
      limit: "10"
    }).toString();
    return chooseExactArtist(term, parseArtistSearch(await this.requestJson(url, deadlineAt, signal)));
  }

  private recordingSearchUrl(query: NormalizedQuery, artistMbids: readonly string[]): URL {
    const clauses: string[] = [];
    if (artistMbids.length > 0) {
      clauses.push(`(${artistMbids.map((mbid) => `arid:${mbid}`).join(" OR ")})`);
    }
    if (query.trackTitles.length > 0) {
      clauses.push(`(${query.trackTitles
        .map((term) => `recording:"${escapeLucenePhrase(term.display)}"`)
        .join(" OR ")})`);
    }
    if (query.tags.length > 0) {
      clauses.push(`(${query.tags
        .map((term) => `tag:"${escapeLucenePhrase(term.display)}"`)
        .join(" OR ")})`);
    }
    const url = new URL("/ws/2/recording/", MUSICBRAINZ_ORIGIN);
    url.search = new URLSearchParams({
      query: clauses.join(" AND "),
      fmt: "json",
      limit: Math.min(50, query.count).toString()
    }).toString();
    return url;
  }

  private makeResult(
    candidates: ExternalMusicCandidate[],
    matchedArtists: MusicBrainzMatchedArtist[],
    matchedArtistMbids: string[]
  ): MusicBrainzCandidateResult {
    return {
      candidates,
      matchedArtists,
      matchedArtistNames: [...new Set(matchedArtists.map((artist) => artist.name))],
      matchedArtistMbids: [...matchedArtistMbids],
      source: "musicbrainz-live",
      attribution: MUSICBRAINZ_ATTRIBUTION,
      fetchedAt: new Date(this.now()).toISOString()
    };
  }

  private async fetchUncached(query: NormalizedQuery, cacheKey: string, signal?: AbortSignal): Promise<MusicBrainzCandidateResult> {
    const deadlineAt = this.now() + this.deadlineMs;
    throwIfAborted(signal);
    const matchedArtists: MusicBrainzMatchedArtist[] = [];
    for (const artist of query.artists) {
      const match = await this.resolveArtist(artist, deadlineAt, signal);
      if (match) matchedArtists.push(match);
    }
    const matchedArtistMbids = [...new Set([
      ...query.artistMbids,
      ...matchedArtists.map((artist) => artist.mbid)
    ])];

    let candidates: ExternalMusicCandidate[] = [];
    // Do not silently broaden an artist-qualified request when none of its artist names resolved exactly.
    if (query.artists.length === 0 || matchedArtistMbids.length > 0) {
      const recordings = await this.requestJson(this.recordingSearchUrl(query, matchedArtistMbids), deadlineAt, signal);
      candidates = parseRecordings(
        recordings,
        query,
        new Set(matchedArtistMbids),
        new Date(this.now()).getUTCFullYear()
      );
    }

    throwIfAborted(signal);
    const result = this.makeResult(candidates, matchedArtists, matchedArtistMbids);
    this.setCached(cacheKey, result);
    return result;
  }

  async searchCandidates(input: MusicBrainzCandidateQuery, options: MusicBrainzSearchOptions = {}): Promise<MusicBrainzCandidateResult> {
    throwIfAborted(options.signal);
    const query = normalizeQuery(input);
    const cacheKey = this.cacheKey(query);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const existing = this.inFlight.get(cacheKey);
    if (existing) return this.subscribeToInFlight(existing, options.signal);
    if (this.inFlight.size >= this.maxInFlightQueries) {
      throw new MusicBrainzServiceError(
        "RATE_LIMITED",
        "MusicBrainz search queue is full; retry after active searches finish",
        { retryable: true, retryAfterMs: REQUEST_INTERVAL_MS }
      );
    }

    const controller = new AbortController();
    const entry: InFlightEntry = {
      promise: Promise.resolve(undefined as never),
      controller,
      subscribers: 0,
      settled: false
    };
    entry.promise = this.fetchUncached(query, cacheKey, controller.signal).finally(() => {
      entry.settled = true;
      if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, entry);
    return this.subscribeToInFlight(entry, options.signal);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
