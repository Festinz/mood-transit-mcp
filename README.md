# MoodTransit(기분환승) MCP

현재 기분을 비슷한 곡으로 덮거나 바로 정반대 분위기로 점프하지 않고, **Mirror → Bridge → Arrive** 순서로 이동시키는 음악 큐레이션 MCP 서버입니다.

정상 동작에서는 [ListenBrainz](https://listenbrainz.org/)와 [MusicBrainz](https://musicbrainz.org/) 공개 데이터에서 요청 조건에 맞는 후보를 가져와 취향·기분·활동·날씨·시간에 맞춰 재순위화합니다. 같은 요청은 10분 동안 공개 데이터 캐시를 재사용합니다. 2026-07 기준 MusicBrainz에는 약 3,942만 recording이 등록돼 있지만, 커뮤니티 카탈로그이므로 전 세계 모든 발매를 보장하지는 않습니다.

공개/fallback 후보의 YouTube Music과 Melon 검색 링크는 각 곡의 `title + artist`로 생성합니다. 공급자가 URL을 전달한 곡은 실제 호스트명이 붙은 전달 링크를 표시합니다. 서버는 YouTube·YouTube Music·Melon의 내부 API를 호출하거나 스크래핑하지 않으며, 해당 서비스의 전체 카탈로그·재생 가능 여부·개인 청취 기록에 접근한다고 주장하지 않습니다.

## 세 도구

| 도구 | 사용 시점 | 후보 범위 |
| --- | --- | --- |
| `build_live_mood_journey` | 다른 음악 MCP 후보가 없을 때 | 요청 조건에 맞는 ListenBrainz·MusicBrainz 공개 후보(10분 캐시 가능) |
| `arrange_candidate_mood_journey` | 공식 Melon MCP 등 다른 도구가 후보를 반환한 뒤 | 전달받은 후보 묶음만 재배열 |
| `refine_mood_journey` | 직전 결과를 더 밝게·차분하게·익숙하게·새롭게 수정 | 제공자 mode는 전달 후보 범위를 보존하고 live mode는 공개 후보를 재조회 |

모든 도구는 읽기 전용이며 동일하게 해석된 문맥과 후보 집합에서는 결정적으로 순위를 계산합니다. live 공개 데이터와 현재 날씨가 바뀌면 후보 집합도 달라질 수 있습니다. 결과의 `selectionScope`는 매번 다음 중 하나를 명시합니다.

- `public_open_catalog`: ListenBrainz·MusicBrainz 공개 데이터에서 이번 요청에 사용한 후보(10분 캐시 가능)
- `provided_candidate_batch`: 다른 MCP가 전달한 후보 묶음
- `curated_fallback`: 공개 경로 장애·후보 부족·요청 필터 불충족 시에만 사용하는 67곡 비상 후보

## 개인화

단독 사용에서는 대화로 받은 다음 취향만 사용합니다.

- 선호·회피 아티스트와 장르
- 한국어·국제·연주곡 선호
- 익숙한 곡과 새로운 발견의 균형
- 현재·목표 기분, 활동, 날씨, 가용 시간
- 후속 대화의 제외곡·밝기·에너지 피드백

계정이나 청취 기록은 저장하지 않습니다. PlayMCP 도구함에 공식 Melon MCP를 함께 넣으면 AI가 Melon의 OAuth 기반 개인 추천·좋아요·최근 재생 도구에서 후보를 받은 뒤 `arrange_candidate_mood_journey`로 넘길 수 있습니다. 기분환승은 그 후보만 3단계로 재배열하고 Melon ID와 의미상 같은 정규화 URL을 보존합니다.

```text
공식 Melon MCP 후보 검색/개인 추천
              ↓
arrange_candidate_mood_journey
              ↓
Mirror → Bridge → Arrive + Melon 전달 링크
```

## 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

서버는 기본 `0.0.0.0:8000`에서 대기하며 `PORT`를 지원합니다.

- MCP: `POST /mcp`
- 서비스 정보: `GET /`
- liveness: `GET /healthz`
- readiness: `GET /readyz`

## 검증

```bash
# 세 MCP 도구 및 실제 공개 후보 확인
REQUIRE_LIVE_CATALOG=1 npm run smoke

# ListenBrainz 태그·아티스트 라디오와 cache 직접 확인
npm run smoke:catalog

# 순수 경로 계산 benchmark
npm run benchmark

# 실행 중인 실제 HTTP MCP endpoint benchmark
MCP_URL=http://127.0.0.1:8000/mcp REQUIRE_LIVE_CATALOG=1 npm run benchmark:endpoint
```

`benchmark:endpoint`는 세 도구의 cold/warm/동시 호출을 측정하고 평균 100ms·p99 3,000ms 기준과 실제 `public_open_catalog` source를 검사합니다. 첫 공개 후보 호출 뒤 같은 요청은 10분 cache를 사용합니다.

검증 범위:

- 12×12 전체 기분 조합의 Mirror → Bridge → Arrive 진행성
- 최대 100개 임의 provider 후보의 결정적 재순위화
- 공식 Melon MCP와 유사한 최소 메타데이터 후보의 개인화
- provider ID·URL 보존, cross-provider MBID/ISRC 중복 제거
- 시간·언어·연주곡·회피·제외·발견 선호
- ListenBrainz 입력·응답 shape, deadline, rate limit, TTL LRU, in-flight 병합
- MCP protocol `2025-03-26`, `2025-11-25`, Origin 403, annotations
- Linux/amd64, non-root Docker, healthcheck

## 외부 데이터와 제한

### ListenBrainz / MusicBrainz

- discovery와 메타데이터 요청은 고정 `https://api.listenbrainz.org` origin만 사용합니다.
- 전체 외부 요청 deadline은 기본 2,700ms입니다.
- 성공 결과는 최대 128개·10분 LRU memory cache에 보관합니다.
- 같은 요청은 in-flight에서 병합하며 `X-RateLimit-*` 헤더를 따릅니다.
- MusicBrainz 핵심 데이터는 CC0, 보조 데이터는 CC BY-NC-SA 조건을 따릅니다.
- 음원·가사·커버 이미지는 저장하거나 반환하지 않습니다.

### YouTube / Melon

- 공식 전체 카탈로그 API를 사용하지 않습니다.
- 생성된 URL은 검색용이며 직접 재생 URL이나 존재 보장이 아닙니다.
- 제공자 후보 mode에서는 입력에 있던 ID·URL만 보존하고 선택 곡 URL에 실제 호스트명을 표시합니다.
- YouTube Data API나 비공식 YouTube Music API를 사용하지 않습니다.
- Melon 직접 검색·개인 추천·재생은 사용자가 별도로 활성화한 공식 Melon MCP의 책임입니다.

### 날씨

`city`가 주어지고 `weather`가 없을 때만 Open-Meteo 현재 날씨를 조회합니다. 주요 국내 8개 도시는 내장 좌표로 forecast 한 번만 호출하며, 결과에는 가공 고지와 CC BY 4.0 링크가 포함됩니다. 날씨 실패는 음악 카탈로그 선택 자체를 막지 않습니다.

## Docker / PlayMCP in KC

```bash
docker build --platform linux/amd64 -t mood-transit-mcp:2.0.0 .
docker run --rm -p 8000:8000 mood-transit-mcp:2.0.0
```

컨테이너 포트는 `8000`입니다. API 키·OAuth·secret은 필요하지 않습니다. 공개 HTTPS endpoint 끝에 `/mcp`를 붙여 PlayMCP에 등록합니다.

구조는 [architecture.md](docs/architecture.md), 보안·개인정보는 [security.md](docs/security.md), 데이터 조건은 [data-provenance.md](docs/data-provenance.md), 등록 문구는 [playmcp-submit.md](docs/playmcp-submit.md)를 참고하세요.

## 라이선스

서버 코드는 MIT License입니다. 외부 데이터는 [NOTICE](NOTICE)와 각 공급자의 조건을 따릅니다.
