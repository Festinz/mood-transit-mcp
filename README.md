# MoodTransit(기분환승) MCP

현재 기분을 단순히 분류하거나 바로 반대 기분의 곡으로 덮지 않고, **Mirror → Bridge → Arrive** 순서로 천천히 이동시키는 음악 큐레이션 MCP 서버입니다. 현재 기분, 원하는 기분, 날씨, 활동, 가용 시간, 언어·연주곡 선호, 제외 아티스트를 함께 반영합니다.

이 서비스는 음악 큐레이션 도구이며 의료·심리 상담이나 치료 효과를 제공하거나 주장하지 않습니다. 음원, 가사, 앨범 아트를 저장하거나 전송하지 않고, 검증한 곡 메타데이터로 YouTube Music과 Melon 또는 Spotify의 검색 URL만 만듭니다.

## 세 단계 전환

1. **Mirror — 지금 비추기:** 현재 기분과 에너지를 먼저 인정합니다.
2. **Bridge — 부드럽게 건너기:** 현재와 목표의 중간 지점을 따라 급격한 점프를 줄입니다.
3. **Arrive — 원하는 기분에 닿기:** 목표 기분에 가까운 밝기와 에너지로 마무리합니다.

추천 순서와 곡 선택은 같은 입력에 대해 결정적입니다. 곡의 `energy`, `valence`, `acousticness`, `familiarity`는 공식 스트리밍 지표가 아니라 이 서비스의 음악 큐레이션용 편집 추정치입니다.

## MCP 도구

| 도구 | 역할 | 외부 통신 |
| --- | --- | --- |
| `build_mood_journey` | 사용자가 준 기분·날씨·활동·시간으로 로컬 결정적 여정 구성 | 없음 |
| `build_weather_journey` | 도시의 현재 날씨를 조회한 뒤 여정 구성 | Open-Meteo 고정 도메인 2개 |
| `refine_mood_journey` | 이전 여정의 기분·시간·맥락·track ID와 한 가지 피드백으로 새 여정 구성 | 없음 |

세 도구 모두 읽기 전용이고 광고, 구독 유도, API 키, 개인정보 수집이 없습니다. 결과는 정제된 Markdown 한 블록과 작은 `structuredContent`만 포함합니다.

## 실행

요구 사항은 Node.js 22 이상입니다.

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

서버는 기본적으로 `0.0.0.0:8000`에서 대기합니다. `PORT` 환경변수로 포트를 바꿀 수 있습니다.

- MCP endpoint: `POST /mcp`
- 배포 플랫폼 기본 확인: `GET /`
- liveness: `GET /healthz`
- readiness: `GET /readyz`

MCP Inspector에서는 transport를 Streamable HTTP로 선택하고 `http://127.0.0.1:8000/mcp`를 입력합니다.

```bash
npx @modelcontextprotocol/inspector
```

대표 SDK 호출을 포함한 자체 smoke test는 별도 서버 없이도 실행됩니다. 배포 URL은 `MCP_URL`로 지정합니다.

```bash
npm run smoke
MCP_URL=https://example.invalid/mcp npm run smoke
npm run benchmark
```

실행 중인 실제 MCP endpoint의 HTTP 성능은 별도 benchmark로 확인합니다. 세 도구의 첫 호출과 warm 호출, 작은 동시 호출 표본에 대해 평균·p50·p95·p99와 오류 수를 JSON으로 출력합니다. 날씨는 첫 호출이 성공해 cache가 준비된 경우에만 기본 30회의 warm 호출과 작은 동시 cache 호출을 추가합니다. 이 호출들은 검증된 메모리 cache만 사용하므로 Open-Meteo 요청 수를 늘리지 않습니다.

```bash
npm start
MCP_URL=http://127.0.0.1:8000/mcp npm run benchmark:endpoint
MCP_URL=https://<PUBLIC_ENDPOINT>/mcp REQUIRE_LIVE_WEATHER=1 npm run benchmark:endpoint
```

조절 가능한 값은 `ENDPOINT_BENCHMARK_ITERATIONS`(기본 20), `ENDPOINT_BENCHMARK_CONCURRENCY`(기본 4), `ENDPOINT_BENCHMARK_WEATHER_WARM_CALLS`(0~100, 기본 30), `ENDPOINT_BENCHMARK_CITY`입니다. `REQUIRE_LIVE_WEATHER=1`이면 첫 날씨 결과가 `open-meteo` 또는 `cache`가 아닐 때 실패합니다. 최초 호출의 `cold`는 benchmark 프로세스에서 해당 tool을 처음 호출했다는 뜻이며, 이미 실행 중인 원격 서버의 process/cache cold 상태까지 보장하지는 않습니다.

## Docker / PlayMCP in KC

이미지는 `linux/amd64`로 빌드합니다.

```bash
docker build --platform linux/amd64 -t mood-transit-mcp:1.0.0 .
docker run --rm -p 8000:8000 mood-transit-mcp:1.0.0
```

컨테이너 포트는 `8000`이며, 플랫폼이 주입하는 `PORT`가 있으면 그 값을 우선합니다. 비밀값이나 API 키는 필요하지 않습니다. 배포 후 받은 공개 HTTPS endpoint 끝에 `/mcp`를 붙여 등록합니다.

## 날씨 데이터와 라이선스

날씨는 [Open-Meteo](https://open-meteo.com/) 데이터이며 분류·가공 사실과 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)을 결과에 표시합니다. 서울·부산·인천·대구·대전·광주·울산·제주는 내장 좌표로 forecast만 한 번 호출하고, 그 밖의 도시는 geocode 후 forecast를 조회합니다. 전체 조회에 2,600ms 데드라인을 적용합니다. 성공 결과는 최대 256개만 10분 LRU 메모리 cache에 보관하고, 같은 도시의 동시 요청은 한 번의 upstream 호출로 합칩니다. 인스턴스당 upstream 요청 예산은 분당 100회입니다. 도시명은 디스크나 로그에 남기지 않으며 실패 시 `unknown` 중립 가중치로 폴백합니다.

이 대회 프로토타입은 Open-Meteo의 free non-commercial endpoint를 사용합니다. 향후 상용 운영 시 적절한 paid 플랜 또는 self-host 배포로 전환하고 attribution을 유지해야 합니다. 자세한 출처는 [데이터 출처 문서](docs/data-provenance.md)를 참고하세요.

## 검증 범위

- 카탈로그 67곡, ID·메타데이터 무결성과 중복 검사
- 한·영 기분 동의어, 단계 순서, 시간 상한, 제외 아티스트, 연주곡·언어 필터
- 132개 모든 서로 다른 기분쌍의 곡 순서·단계 중심 단조 전이
- refine의 이전 곡 제외, 이전 경로·시간·맥락 보존, familiar/discovery 방향
- 날씨 성공·LRU cache·동시 요청 병합·요청 예산·strict deadline 폴백
- HTTP root/health/readiness/body limit/method/Origin 검증
- MCP SDK `initialize`, `tools/list`, 세 도구 대표 호출, 필수 annotations
- protocol `2025-03-26`, `2025-11-25`
- 로컬 평균 100ms, p99 3,000ms 기준 benchmark

설계는 [architecture.md](docs/architecture.md), 보안·개인정보 원칙은 [security.md](docs/security.md), 등록용 복사 문구는 [playmcp-submit.md](docs/playmcp-submit.md)에 있습니다.

## 라이선스

서버 코드는 MIT License입니다. 외부 데이터와 사실 메타데이터는 [NOTICE](NOTICE)의 별도 조건을 따릅니다.
