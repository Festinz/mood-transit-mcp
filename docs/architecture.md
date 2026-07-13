# Architecture

MoodTransit(기분환승) v2.3 is a stateless MCP server that turns unrestricted natural-language mood, weather, activity, metaphor, and sensory-vibe requests into a three-stage music journey: **Mirror → Bridge → Arrive**. The PlayMCP host preserves the complete utterance as `requestText` and supplies a bounded `semanticIntent`: continuous 0..1 current/target valence, energy, and acousticness axes plus concise English discovery and exclusion tags inferred from the whole sentence. The 12 canonical moods remain display and backward-compatibility anchors, not an input vocabulary; ranking interpolates the continuous semantic vectors directly. Its standalone path then uses request-matched public ListenBrainz/MusicBrainz data with condition-aware fallback, bounded artist-alias search, exact-title search, and a 10-minute cache. The bundled 67-track catalog is used only when public paths fail or remain too small, while explicit artist-only failures stay actionable.

```text
PlayMCP client
    │
    └── POST /mcp (stateless Streamable HTTP, direct JSON response)
          │
          ├── build_live_mood_journey
          │     ├── verbatim requestText + bounded host semanticIntent
          │     ├── continuous vector path; canonical moods are display anchors
          │     ├── optional Open-Meteo current weather lookup
          │     ├── condition-aware ListenBrainz/MusicBrainz tag fallback
          │     ├── MusicBrainz artist/alias and exact-title search
          │     ├── ListenBrainz batch endpoint for MusicBrainz metadata
          │     ├── deterministic Mirror → Bridge → Arrive ranking
          │     └── 67-track curated fallback only on live failure/shortage
          │
          ├── arrange_candidate_mood_journey
          │     ├── receives an exact candidate batch from another authorized tool
          │     └── preserves provider IDs, ranks, and URLs while reordering
          │
          └── refine_mood_journey
                ├── live mode: may query ListenBrainz again for replacements
                └── supplied-candidate mode: decodes the bounded client-carried candidate token
```

## Transport and process model

- Node.js, TypeScript, Express, and `@modelcontextprotocol/sdk` provide the server runtime.
- `POST /mcp` is the only MCP method. GET streams, SSE subscriptions, DELETE sessions, and server-side MCP sessions are not provided.
- A fresh `McpServer` and stateless transport are created for each request. `sessionIdGenerator` is disabled.
- The response uses Streamable HTTP direct JSON with Markdown plus compact `structuredContent`.
- `/healthz` and `/readyz` expose liveness and readiness without invoking upstream services.

## The three tools

### `build_live_mood_journey`

This is the normal standalone entry point. It uses only the current request: the verbatim `requestText`, host-interpreted `semanticIntent`, time, optional activity/weather/city, stated artist, song-title or genre preferences, artist-only scope, exclusions, discovery preference, language preference, and an optional MusicBrainz artist MBID.

The live pipeline is:

1. Preserve the user's complete original sentence as provenance; never paste that full sentence into a catalog query.
2. Accept bounded host interpretation of the whole sentence as continuous current/target valence, energy, and acousticness axes with 1–8 concise discovery tags and optional exclusion tags. A request containing `requestText` without meaningful `semanticIntent` returns `SEMANTIC_INTENT_REQUIRED` instead of silently defaulting. Validate every axis and require one to five English catalog words per semantic tag; case is accepted for prior refinement-state compatibility and normalized at the outbound boundary. The JSON Schema-visible pattern rejects common credential/secret, explicit personal name/address, request-copy marker, personal numeric, and opaque-ID forms.
3. Use the continuous vectors for phase interpolation and candidate path distance. Select the nearest of 12 canonical moods only for display/backward compatibility. If semantic intent is absent, use tolerant legacy parsing and report `semanticCoverage=canonical_fallback`.
4. Build bounded discovery tags from host semantic tags, free-form activity, normalized weather, desired vibe, and explicit preferences. Exclusion tags are local candidate filters.
5. Query `GET /1/lb-radio/tags` and MusicBrainz `GET /ws/2/recording/?query=tag:...`. Generic legacy requests can finish on a feasible ListenBrainz batch. Semantic/context cold paths start ListenBrainz first and launch the bounded MusicBrainz hedge after 175 ms only when strict metadata has not arrived. A strict first batch returns immediately and cancels an already-started MusicBrainz loser before it can consume the global rate-limit queue. A broadened first batch waits only within the 2.4-second total hedge window for a strict peer before proceeding. Exact repeated discovery decisions are cached for ten minutes, so warm calls perform only the final ranking.
6. When the user names an artist, resolve exact name/alias hits through `GET /ws/2/artist/`; when an artist or title is named, search `GET /ws/2/recording/` and locally enforce exact normalized matches.
7. Deduplicate targeted, ListenBrainz, and MusicBrainz tag-search recording MBIDs, retain factual metadata, apply hard filters and exclusion tags, and rank with the continuous semantic path.
8. Prefer candidates carrying requested semantic/context tags. Report `contextMatchMode=strict` only when the selected tracks collectively expose every requested dynamic semantic tag; weather and other compatibility context tags remain additional ranking signals. Otherwise report `broadened` with `matchedSemanticTags` and `unmatchedSemanticTags`. This is not represented as proof that every requested nuance exists in community metadata.
9. If public discovery fails or remains too small, switch explicitly to the 67-track fallback. Explicit artist-only no-match/shortage errors instead direct the caller to another spelling or an authorized provider search.

The live data is broad public community metadata, not a complete or guaranteed representation of every release or streaming service.

### `arrange_candidate_mood_journey`

This tool accepts 3–20 tracks already returned by an authorized music provider tool. It does not call or scrape that provider itself. It preserves supplied provider IDs, original ranks, personalization signals, and provider URLs, then reorders only that batch into the three-stage journey.

When the official Melon MCP is present in the host's toolbox, the host/agent can first obtain authorized Melon candidates and then pass them to this tool. MoodTransit does not claim access to Melon's full catalog and does not invent Melon availability or URLs.

### `refine_mood_journey`

The caller passes the prior result's `structuredContent.refinementState` unchanged and specifies bounded changes such as calmer/brighter, more/less energy, more familiar/discovery-oriented, a new target mood or duration, exclusions, or artist avoidance.

- Live-open-catalog state may query ListenBrainz and MusicBrainz again and still uses the fallback only when the public paths fail or remain too small.
- Supplied-candidate state selects only from the upstream pool preserved in a bounded, checksummed, compressed token inside `refinementState`; the server stores no conversation state. If that pool can no longer fill all three stages, the tool requests a fresh provider batch rather than inventing tracks.

## Deterministic journey ranking

Candidates are scored against the continuous current→target vectors interpolated for the three phases. The scoring combines metadata tags, target-vector distance, dynamic inclusion/exclusion tags, explicit likes or recent-play signals supplied by an upstream provider, favorite/avoided artists and genres, discovery preference, duration fit, weather/activity tags, and artist diversity.

A bounded beam search chooses an ordered sequence within the requested 10–60 minute budget. Stable candidate identifiers break ties, so identical inputs and candidate data produce the same order. These scores are MoodTransit editorial calculations, not official audio features or therapeutic measurements.

## Provider composition and outbound links

- ListenBrainz/MusicBrainz is the normal live candidate source for standalone calls.
- An authorized provider such as the official Melon MCP can supply an exact candidate batch for `arrange_candidate_mood_journey`.
- Public/fallback tracks receive bounded, dynamically encoded YouTube Music and Melon **search URLs** based on title and artist. A supplied candidate with a provider URL shows that caller-provided URL instead.
- Search URLs are navigation aids only. They do not prove that a track exists, is playable, or is available in the user's region or account.
- The server does not return audio, lyrics, cover art, preview files, or fabricated direct-play URLs.

## Upstream reliability

### ListenBrainz/MusicBrainz live candidates

- ListenBrainz requests use the fixed HTTPS origin `https://api.listenbrainz.org`; public tag and text search use the fixed `https://musicbrainz.org/ws/2/` origin.
- Redirects and responses escaping that origin are rejected.
- Radio discovery and batch metadata enrichment share one 2,700 ms total deadline.
- Successful results use a 10-minute in-memory TTL LRU with at most 128 keys.
- Concurrent equivalent lookups share one in-flight promise.
- `X-RateLimit-Remaining`, `X-RateLimit-Reset-In`, `X-RateLimit-Reset`, and `Retry-After` are honored. A reset is awaited only when it fits inside the total deadline; otherwise the live request fails clearly and the journey path can use the fallback.
- MusicBrainz tag/text-search requests are serialized to at most one request per second, use a meaningful User-Agent, reject redirects and oversized JSON, and use their own bounded total deadline and 10-minute LRU.

### Open-Meteo weather

- Fixed origins: `https://geocoding-api.open-meteo.com` and `https://api.open-meteo.com`.
- Known Korean cities use built-in coordinates; other city names use geocoding followed by current weather. A city-only request resolves weather before candidate discovery so the observed condition is present in both search tags and ranking.
- The weather chain has a 2,600 ms total deadline, a 10-minute in-memory TTL LRU capped at 256 entries, in-flight deduplication, and a local 100-request-per-minute budget.
- Weather failure omits weather context; it does not block music generation or invent a condition.

## Output contract

Markdown identifies the source mode, three stages, estimated duration, reasons, and search links. `structuredContent` preserves source provenance, candidate scope, track metadata, limitations, and the bounded refinement state needed for a follow-up. The output explicitly distinguishes:

- `public_open_catalog`: candidates from public ListenBrainz/MusicBrainz data for this request (possibly from the 10-minute cache);
- `provided_candidate_batch`: only the batch supplied by another authorized tool;
- `curated_fallback`: the 67-track emergency catalog used because the live path was unavailable or insufficient.
