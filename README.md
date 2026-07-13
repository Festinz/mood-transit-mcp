# MoodTransit(기분환승) MCP

현재 기분을 비슷한 곡으로 덮거나 바로 정반대 분위기로 점프하지 않고, **Mirror → Bridge → Arrive** 순서로 이동시키는 음악 큐레이션 MCP 서버입니다.

정상 동작에서는 [ListenBrainz](https://listenbrainz.org/)와 [MusicBrainz](https://musicbrainz.org/) 공개 데이터에서 요청 조건에 맞는 후보를 가져와 취향·기분·활동·날씨·분위기·시간에 맞춰 재순위화합니다. PlayMCP 호스트는 사용자의 전체 문장을 `requestText`로 보존하고, 사전에 없는 감정·비유·부정·소리 질감까지 0~1 연속 의미 좌표와 짧은 동적 음악 태그로 `semanticIntent`에 전달합니다. 12개 감정은 더 이상 입력 허용 목록이 아니라 결과 표시와 구버전 호환용 anchor일 뿐이며, 실제 Mirror → Bridge → Arrive 계산은 전달된 연속 좌표를 따라갑니다.

공개 검색 경로는 단순히 먼저 3곡을 반환한 쪽을 채택하지 않고, 실제 필터·3단계 구성·날씨/분위기 태그 일치 여부를 확인합니다. 부정된 질감은 `excludeTags`로 후보에서 제외하고, 야간 운전·공부·운동 같은 자유 활동도 검색 태그에 반영합니다. 호스트가 `semanticIntent`를 빠뜨려도 요청을 실패시키지 않고, 서버가 원문에서 부정되지 않은 것으로 확인한 기분·감각 표현과 전용 날씨·활동 필드만 고정 허용 태그와 연속 좌표로 안전하게 보완하며 `semanticSource=server_inferred`를 표시합니다. 의미 신호를 확인할 수 없는 원문은 임의로 태그화하지 않고 `canonical_fallback`으로 처리합니다. 결과는 선택 곡 메타데이터에서 직접 확인된/확인되지 않은 동적 태그도 구분합니다. 아티스트 이름은 한글·영문 이름과 MusicBrainz 별칭으로 해석하고, 사용자가 지정한 곡명은 공개 recording 검색으로 확인합니다. 같은 요청은 10분 동안 공개 데이터 캐시를 재사용합니다.

공개/fallback 후보의 YouTube Music과 Melon 검색 링크는 각 곡의 `title + artist`로 생성합니다. 공급자가 URL을 전달한 곡은 실제 호스트명이 붙은 전달 링크를 표시합니다. 서버는 YouTube·YouTube Music·Melon의 내부 API를 호출하거나 스크래핑하지 않으며, 해당 서비스의 전체 카탈로그·재생 가능 여부·개인 청취 기록에 접근한다고 주장하지 않습니다.

## 세 도구

| 도구 | 사용 시점 | 후보 범위 |
| --- | --- | --- |
| `build_live_mood_journey` | 다른 음악 MCP 후보가 없을 때 | 자유 문장 연속 의미·동적 태그·날씨·활동과 명시한 아티스트·곡명에 맞는 ListenBrainz·MusicBrainz 공개 후보(10분 캐시 가능) |
| `arrange_candidate_mood_journey` | 공식 Melon MCP나 사용자가 활성화한 YouTube Data MCP 등 다른 도구가 후보를 반환한 뒤 | 전달받은 후보 묶음만 재배열 |
| `refine_mood_journey` | 직전 결과를 더 밝게·차분하게·익숙하게·새롭게 수정 | 제공자 mode는 전달 후보 범위를 보존하고 live mode는 공개 후보를 재조회 |

모든 도구는 읽기 전용이며 동일하게 해석된 문맥과 후보 집합에서는 결정적으로 순위를 계산합니다. live 공개 데이터와 현재 날씨가 바뀌면 후보 집합도 달라질 수 있습니다. 결과의 `selectionScope`는 매번 다음 중 하나를 명시합니다.

날씨·분위기 태그가 붙은 사용 가능한 후보가 3개 이상이면 그 후보만 먼저 사용합니다(`contextMatchMode=strict`). 공개 메타데이터의 태그가 부족하면 결과를 끊지 않고 감정 경로·일반 태그까지 넓히며 `contextMatchMode=broadened`와 한계 문구를 함께 반환합니다.

- `public_open_catalog`: ListenBrainz·MusicBrainz 공개 데이터에서 이번 요청에 사용한 후보(10분 캐시 가능)
- `provided_candidate_batch`: 다른 MCP가 전달한 후보 묶음
- `curated_fallback`: 공개 경로 장애·후보 부족·요청 필터 불충족 시에만 사용하는 67곡 비상 후보

## 개인화

단독 사용에서는 대화로 받은 다음 취향만 사용합니다.

- 선호·회피 아티스트와 장르, 명시한 곡명, 아티스트 한정 여부
- 한국어·국제·연주곡 선호
- 익숙한 곡과 새로운 발견의 균형
- 사용자 원문, 현재·목표의 연속 감정 좌표, 원하는/피할 동적 음악 태그, 활동, 날씨, 가용 시간
- 후속 대화의 제외곡·밝기·에너지 피드백

계정이나 청취 기록은 저장하지 않습니다. PlayMCP 도구함에 공식 Melon MCP를 함께 넣으면 AI가 Melon의 검색·개인 추천 도구에서 후보를 받은 뒤 `arrange_candidate_mood_journey`로 넘길 수 있습니다. 사용자가 별도로 활성화한 YouTube Data MCP도 같은 방식으로 검색 결과를 넘길 수 있습니다. 기분환승은 전달된 후보만 3단계로 재배열하고 ID와 의미상 같은 정규화 URL을 보존합니다.

```text
공식 Melon MCP 또는 활성화한 YouTube Data MCP 검색
                         ↓
arrange_candidate_mood_journey
                         ↓
Mirror → Bridge → Arrive + 공급자 전달 링크
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
- MusicBrainz 기분·날씨·분위기 tag 검색, 한글 별칭→아티스트 MBID 해석, 정확한 곡명 검색, 1 req/sec 직렬 제한, TTL LRU, in-flight 병합
- 날씨·감각 표현이 mood 필드로 들어온 기존 호출과 mood를 생략한 날씨·분위기 전용 호출
- MCP protocol `2025-03-26`, `2025-11-25`, Origin 403, annotations
- Linux/amd64, non-root Docker, healthcheck

## 외부 데이터와 제한

### ListenBrainz / MusicBrainz

- ListenBrainz discovery와 메타데이터 요청은 고정 `https://api.listenbrainz.org` origin만 사용합니다.
- 전체 외부 요청 deadline은 기본 2,700ms입니다.
- 성공 결과는 최대 128개·10분 LRU memory cache에 보관합니다.
- 같은 요청은 in-flight에서 병합하며 `X-RateLimit-*` 헤더를 따릅니다.
- 기분·날씨·분위기 tag 검색과 아티스트·곡명 텍스트 검색은 고정 `https://musicbrainz.org/ws/2/` origin만 사용하고, MusicBrainz의 1 req/sec 제한을 직렬화해 지킵니다.
- 아티스트 텍스트 검색은 한글 별칭을 정규 아티스트명·MBID로 확인한 뒤 recording을 조회하며, 성공 결과는 최대 128개·10분 LRU cache에 보관합니다.
- MusicBrainz 핵심 데이터는 CC0, 보조 데이터는 CC BY-NC-SA 조건을 따릅니다.
- 음원·가사·커버 이미지는 저장하거나 반환하지 않습니다.

### YouTube / Melon

- 공식 전체 카탈로그 API를 사용하지 않습니다.
- 생성된 URL은 검색용이며 직접 재생 URL이나 존재 보장이 아닙니다.
- 제공자 후보 mode에서는 입력에 있던 ID·URL만 보존하고 선택 곡 URL에 실제 호스트명을 표시합니다.
- 기분환승 서버 자체는 YouTube Data API나 비공식 YouTube Music API를 사용하지 않습니다. PlayMCP에서 별도로 활성화한 YouTube Data MCP의 검색 결과는 후보 묶음으로 받을 수 있습니다.
- 외부 YouTube Data MCP의 가용성·일일 API quota·검색 정확도는 해당 MCP 운영 범위이며, 실패하면 기분환승이 실제 YouTube 결과를 보장하지 않습니다.
- Melon 직접 검색·개인 추천·재생은 사용자가 별도로 활성화한 공식 Melon MCP의 책임입니다.

### 날씨

`city`가 주어지고 `weather`가 없을 때만 Open-Meteo 현재 날씨를 먼저 조회한 뒤 그 결과를 후보 검색 태그와 순위에 함께 반영합니다. 주요 국내 8개 도시는 내장 좌표로 forecast 한 번만 호출하며, 결과에는 가공 고지와 CC BY 4.0 링크가 포함됩니다. 날씨 실패는 음악 카탈로그 선택 자체를 막지 않습니다.

## Docker / PlayMCP in KC

```bash
docker build --platform linux/amd64 -t mood-transit-mcp:2.3.1 .
docker run --rm -p 8000:8000 mood-transit-mcp:2.3.1
```

컨테이너 포트는 `8000`입니다. API 키·OAuth·secret은 필요하지 않습니다. 공개 HTTPS endpoint 끝에 `/mcp`를 붙여 PlayMCP에 등록합니다.

구조는 [architecture.md](docs/architecture.md), 보안·개인정보는 [security.md](docs/security.md), 데이터 조건은 [data-provenance.md](docs/data-provenance.md), 등록 문구는 [playmcp-submit.md](docs/playmcp-submit.md)를 참고하세요.

## 라이선스

서버 코드는 MIT License입니다. 외부 데이터는 [NOTICE](NOTICE)와 각 공급자의 조건을 따릅니다.
