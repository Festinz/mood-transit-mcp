# Data provenance

MoodTransit separates candidate discovery, factual metadata, editorial ranking, provider availability, and weather provenance. A result states which candidate scope was actually used and does not imply access to a complete streaming catalog.

## Free-text semantic interpretation

For natural-language calls, the PlayMCP host is instructed to preserve the complete user utterance in `requestText` and convert its meaning into bounded `semanticIntent` data: optional current/target valence, energy, and acousticness axes plus up to eight concise English discovery tags and eight exclusion tags. This allows unfamiliar feelings, metaphor, negation, activity, and sound texture to cross the MCP boundary without treating a fixed mood dictionary as the allowed input set.

The full `requestText` is provenance only and is never placed directly into a ListenBrainz or MusicBrainz query. When `semanticIntent` is absent or empty, only negation-aware mood/sensory matches in the text and dedicated weather/activity fields select fixed allowlisted English tags; arbitrary request words are not converted into outbound tags. Explicit genre preferences may also use Korean catalog words and prior refinement state may retain case, but every dynamic outbound tag is normalized and passes the same schema-visible guard against common credential/secret markers, explicit name/address and request-copy markers, personal numeric identifiers, key forms, and opaque IDs; MusicBrainz query phrases remain escaped. This is a bounded common-pattern defense, not a claim that arbitrary prose can be perfectly classified as sensitive. Recognized fallback is labeled `server_inferred`, while no-signal text remains `canonical_fallback`.

Host-supplied and server-inferred axes and tags are soft interpretations, not user-stated facts or official provider audio features. Results expose `semanticSource`, `semanticCoverage`, the nearest canonical display anchors, all bounded requested tags, `matchedSemanticTags`/`unmatchedSemanticTags` from the selected tracks' community metadata, and whether catalog matching was strict or broadened.

## Normal live candidate path

The normal standalone path uses two public discovery routes with condition-aware fallback. It validates preference filters, three-stage feasibility, and requested context metadata instead of accepting whichever route merely returns three raw records first. Equivalent queries use a 10-minute in-memory cache:

- ListenBrainz tag radio for mood, weather, activity, and vibe-oriented discovery, plus optional artist radio when the caller supplies a MusicBrainz artist MBID;
- the official MusicBrainz recording search API with bounded community-tag queries for mood, weather, activity, and vibe-oriented discovery;
- a ListenBrainz batch recording metadata request for MusicBrainz-backed title, artist, duration, recording/artist MBIDs, ISRC, release, year, and community tags when the ListenBrainz route wins.

For a generic legacy request, a usable ListenBrainz result can finish the request without starting a redundant MusicBrainz tag search. For a semantic, weather, or vibe request, ListenBrainz starts first; the bounded MusicBrainz hedge opens after 175 ms only when strict metadata has not already arrived. A strict first batch returns immediately and aborts an already-started MusicBrainz loser so it releases the global one-request-per-second queue. If the first batch can only produce a broadened result, MoodTransit waits within a 2.4-second total hedge window for the peer and keeps a strict result when one arrives; after that bound it proceeds with the available batch and reports the limitation. Exact discovery decisions use a hashed ten-minute in-memory cache. The two routes are a resilience strategy, not two complete catalogs. The response names only the route or routes actually used in `sources` and reports `selectionScope.kind=public_open_catalog`.

When the user explicitly names an artist or song, the standalone path also uses the official MusicBrainz search API. Artist names are matched against normalized names and aliases before an MBID-qualified recording search; requested song titles are checked for exact normalized equality. The result reports requested and matched names in `searchResolution` and does not silently claim an unmatched artist or title.

ListenBrainz describes its public listen data and text as available under CC0. Its service terms and third-party resource notices remain applicable:

- [ListenBrainz Terms of Service](https://listenbrainz.org/terms-of-service/)
- [ListenBrainz API documentation](https://listenbrainz.readthedocs.io/en/latest/users/api/index.html)

MusicBrainz is a community-maintained music encyclopedia. Its database is large but incomplete and may contain missing, delayed, duplicated, or community-edited metadata. MoodTransit therefore never claims that the live results include every song, every release, or every item available from YouTube, Melon, or another provider.

When the request includes semantic, weather, or vibe context, MoodTransit first tries to select candidates whose returned community metadata matches that context. It reports `contextMatchMode=strict` only when selected metadata collectively covers every requested dynamic semantic tag. Otherwise it reports `broadened` and lists directly matched and unmatched semantic tags instead of inventing full agreement.

MusicBrainz separates its database licensing as follows:

- core data: [CC0](https://creativecommons.org/publicdomain/zero/1.0/);
- supplementary data: [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), requiring attribution, non-commercial use, and share-alike treatment where applicable.

See [MusicBrainz Data License](https://musicbrainz.org/doc/About/Data_License). Results retain ListenBrainz/MusicBrainz attribution, and deployers must review the current license and commercial-use terms for their own use case.

## Curated fallback catalog

The repository includes 67 factual track records. They are used only when the live ListenBrainz/MusicBrainz path fails, is rate-limited, exceeds its deadline, returns an invalid response, or provides fewer than three usable candidates.

Fallback records contain title, artist, year, approximate duration, and MoodTransit-authored recommendation attributes. They contain no audio, lyrics, or artwork. Their mood, energy, valence, acousticness, familiarity, weather, and activity values are editorial estimates, not streaming-provider audio features.

A fallback result is labeled `curated_fallback` and includes the reason. The fallback catalog is not represented as a comprehensive catalog or as the normal source.

## Authorized provider candidate batches

`arrange_candidate_mood_journey` can rank an exact batch supplied by another authorized tool. For example, when the official Melon MCP is available, the host/agent may call it first and pass its returned candidates to MoodTransit.

MoodTransit:

- preserves supplied provider IDs, original ranks, personalization values, and URLs;
- ranks only the supplied batch;
- does not call, proxy, or scrape Melon itself;
- does not infer that the batch represents the provider's complete catalog;
- does not invent provider availability, IDs, or direct-play URLs.

Any private-history or account-derived signal in such a batch remains data supplied for that request by the authorized upstream tool. MoodTransit does not retrieve that history itself. Follow-up data is carried only in the bounded compressed `refinementState` token returned to the caller and is not persisted server-side.

## Search links and availability

For public/fallback selected tracks, MoodTransit encodes a bounded title-and-artist query into:

- a YouTube Music search URL;
- a Melon search URL.

These are search/navigation links only. A supplied provider candidate with its own URL shows that caller-provided URL instead and labels it with the actual hostname. MoodTransit does not use the YouTube Data API or a Melon catalog API, does not inspect the search result, and does not guarantee that the recording is present, playable, correctly matched, regionally available, or accessible under the user's account. Direct playback and account permissions remain with the relevant service or authorized provider MCP.

## Weather

Current weather and geocoding are provided by [Open-Meteo](https://open-meteo.com/). MoodTransit maps weather code, temperature, and wind into a small editorial weather context. Output retains attribution under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

The server uses Open-Meteo without an end-user account and stores successful results only in a short-lived in-memory cache. Deployers must use an Open-Meteo plan or self-hosted configuration appropriate to their traffic and retain attribution.

## Mood and recommendation calculations

MoodTransit's canonical mood vectors, phase interpolation, inferred mood labels, popularity normalization, diversity penalties, and Mirror → Bridge → Arrive scores are software-defined editorial calculations. They are not official ListenBrainz, MusicBrainz, Melon, YouTube, Apple, or Spotify audio features, and they do not establish a therapeutic effect.

Track duration may be absent from live or provider metadata. When necessary, ranking uses a disclosed planning estimate; it does not present that estimate as an authoritative provider duration.

## Storage and privacy boundary

- No audio, lyrics, cover art, preview files, or copied provider playlists are stored.
- No streaming credential, private listening history, or durable user taste profile is collected.
- Caches are in-memory TTL LRUs and vanish on restart.
- Personalization comes from the current explicit request or from the exact candidate batch supplied by an authorized upstream tool.
