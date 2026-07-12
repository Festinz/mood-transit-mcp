# Data provenance

MoodTransit separates candidate discovery, factual metadata, editorial ranking, provider availability, and weather provenance. A result states which candidate scope was actually used and does not imply access to a complete streaming catalog.

## Normal live candidate path

The normal standalone path uses public ListenBrainz APIs, with a 10-minute in-memory cache for equivalent queries:

- tag radio for mood/genre-oriented discovery;
- optional artist radio when the caller supplies a MusicBrainz artist MBID;
- a batch recording metadata request for MusicBrainz-backed title, artist, duration, recording/artist MBIDs, ISRC, release, year, and community tags.

ListenBrainz describes its public listen data and text as available under CC0. Its service terms and third-party resource notices remain applicable:

- [ListenBrainz Terms of Service](https://listenbrainz.org/terms-of-service/)
- [ListenBrainz API documentation](https://listenbrainz.readthedocs.io/en/latest/users/api/index.html)

MusicBrainz is a community-maintained music encyclopedia. Its database is large but incomplete and may contain missing, delayed, duplicated, or community-edited metadata. MoodTransit therefore never claims that the live results include every song, every release, or every item available from YouTube, Melon, or another provider.

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
