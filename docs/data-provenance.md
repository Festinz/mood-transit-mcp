# Data provenance

## 곡 메타데이터

카탈로그의 곡 실재 여부, 공식 표기, 아티스트, 발매 연도, 곡 길이는 2026-07-12 기준 Apple Music/iTunes 공개 카탈로그와 아티스트·앨범의 공개 디스코그래피를 교차 확인했습니다. 카탈로그는 한국 대중음악, 국제 대중음악, 연주곡을 고르게 포함합니다.

곡 길이는 서비스와 판본에 따라 몇 초 차이가 날 수 있으므로 큐레이션 시간 계산용 근사값으로 취급합니다. 서버는 title·artist로 다음 검색 URL만 동적으로 만듭니다.

- YouTube Music search
- 한국어 카탈로그: Melon search
- 그 외 카탈로그: Spotify search

서버와 저장소에는 음원, 가사, 악보, 앨범 아트, 아티스트 사진, 플랫폼의 직접 track/play URL이 없습니다. 검색 결과의 제공 가능 여부와 재생 권한은 해당 음악 서비스와 사용자 계정·지역 조건을 따릅니다.

## 추천 속성

`energy`, `valence`, `acousticness`, `familiarity`, mood/weather/activity tag는 MoodTransit의 결정적 음악 큐레이션을 위한 자체 편집 추정치입니다. Apple, Spotify 또는 다른 스트리밍 서비스가 제공한 공식 audio feature라고 주장하지 않습니다. 이 값은 의료·심리 평가나 치료 효과의 근거가 아닙니다.

## 날씨

현재 날씨와 지오코딩은 [Open-Meteo](https://open-meteo.com/)가 제공하며 [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)에 따라 출처를 표시합니다. 원본 weather code·기온·풍속을 MoodTransit이 큐레이션용 상태로 분류·가공했다는 사실도 결과 Markdown과 structured data에 함께 표시합니다.

대회 프로토타입은 광고·구독 없이 Open-Meteo의 free non-commercial endpoint를 사용합니다. 공식 무료 한도는 10,000 calls/day, 5,000/hour, 600/minute이며, 서버는 cache·동시 요청 병합·분당 100회 upstream 예산으로 이를 보조합니다. 상용 운영 또는 더 큰 트래픽에서는 적절한 paid 플랜이나 self-host Open-Meteo로 전환하고 attribution을 유지해야 합니다.

## 갱신 절차

곡을 추가하거나 수정할 때는 공개 카탈로그에서 title, artist, year, duration을 다시 대조하고, ID 중복·범위·카탈로그 그룹을 `tests/catalog.test.ts`로 검증합니다. 추천 추정치를 수정하면 변경 이유와 benchmark/test 결과를 함께 검토합니다.
