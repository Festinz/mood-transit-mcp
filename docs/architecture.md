# Architecture

MoodTransit(기분환승) v2.2 is a stateless MCP server that turns mood, weather, and sensory-vibe requests into a three-stage music journey: **Mirror → Bridge → Arrive**. Explicit moods are optional at the MCP boundary; weather-only requests default to a neutral current state, while descriptors such as `더운`, `시원한`, `청량한`, `cozy`, and `dreamy` are preserved as bounded discovery context. Its normal standalone path uses request-matched public ListenBrainz/MusicBrainz data, including condition-aware tag discovery fallback, bounded artist-alias search, and exact-title search, with a 10-minute cache for equivalent queries. A route is accepted only after preference filters, three-stage feasibility, and requested context metadata are checked. The bundled 67-track catalog is used only when both general live paths are unavailable, yield fewer than three usable candidates, or cannot satisfy the requested filters. An explicit artist-only request returns an actionable search error instead of silently substituting unrelated fallback tracks.

```text
PlayMCP client
    │
    └── POST /mcp (stateless Streamable HTTP, direct JSON response)
          │
          ├── build_live_mood_journey
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

This is the normal standalone entry point. It uses only the user's explicit request: optional current and target mood, desired sensory vibe, time, optional activity/weather/city, stated artist, song-title or genre preferences, artist-only scope, exclusions, discovery preference, language preference, and an optional MusicBrainz artist MBID.

The live pipeline is:

1. Separate mood, weather, and sensory-vibe wording. Normalize known Korean or English mood text into one of 12 canonical moods, map recognized sensory descriptors to bounded music tags, and use a neutral mood default when no emotion was stated.
2. Convert the current and target moods into internal valence, energy, and acousticness vectors.
3. Build bounded discovery tags from the mood path, normalized weather, desired vibe, and explicit preferences.
4. Query `GET /1/lb-radio/tags` and MusicBrainz `GET /ws/2/recording/?query=tag:...` through condition-aware fallback: generic requests can finish on a feasible ListenBrainz batch, while context requests prefer a strict context-bearing batch and query the other route when needed.
5. When the user names an artist, resolve exact name/alias hits through `GET /ws/2/artist/`; when an artist or title is named, search `GET /ws/2/recording/` and locally enforce exact normalized matches.
6. Deduplicate targeted, ListenBrainz, and MusicBrainz tag-search recording MBIDs; enrich ListenBrainz discoveries; and retain MusicBrainz title, artist, duration, ISRC, release, and community tags.
7. Filter and score the returned candidates, applying `artistScope=only` only when the user explicitly asks for that artist's songs. When at least three candidates carry a requested weather/vibe tag, select only from that strict context pool; otherwise broaden explicitly and report `contextMatchMode=broadened`.
8. If the general live request fails, is rate-limited, exceeds its deadline, returns an invalid response, or leaves fewer than three candidates, switch explicitly to the bundled 67-track fallback catalog. Explicit artist-only no-match/shortage errors instead direct the caller to another spelling or an authorized provider search.

The live data is broad public community metadata, not a complete or guaranteed representation of every release or streaming service.

### `arrange_candidate_mood_journey`

This tool accepts 3–20 tracks already returned by an authorized music provider tool. It does not call or scrape that provider itself. It preserves supplied provider IDs, original ranks, personalization signals, and provider URLs, then reorders only that batch into the three-stage journey.

When the official Melon MCP is present in the host's toolbox, the host/agent can first obtain authorized Melon candidates and then pass them to this tool. MoodTransit does not claim access to Melon's full catalog and does not invent Melon availability or URLs.

### `refine_mood_journey`

The caller passes the prior result's `structuredContent.refinementState` unchanged and specifies bounded changes such as calmer/brighter, more/less energy, more familiar/discovery-oriented, a new target mood or duration, exclusions, or artist avoidance.

- Live-open-catalog state may query ListenBrainz and MusicBrainz again and still uses the fallback only when the public paths fail or remain too small.
- Supplied-candidate state selects only from the upstream pool preserved in a bounded, checksummed, compressed token inside `refinementState`; the server stores no conversation state. If that pool can no longer fill all three stages, the tool requests a fresh provider batch rather than inventing tracks.

## Deterministic journey ranking

Candidates are scored against interpolated mood vectors for the three phases. The scoring combines metadata tags, target-vector distance, explicit likes or recent-play signals supplied by an upstream provider, favorite/avoided artists and genres, discovery preference, duration fit, weather/activity tags, and artist diversity.

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
