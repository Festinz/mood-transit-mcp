# Architecture

## 요청 흐름

```text
PlayMCP client
    │ POST /mcp (Streamable HTTP, JSON response)
    ▼
Express input limit (64 KiB)
    ▼
Fresh McpServer + fresh stateless transport per request
    ├── build_mood_journey ──────────────┐
    ├── refine_mood_journey ─────────────┤
    └── build_weather_journey             │
             │                            │
             ├── Open-Meteo geocoding    │
             ├── Open-Meteo current      │
             └── cache/fallback           │
                                          ▼
                              deterministic journey engine
                                          │
                                  curated metadata catalog
                                          ▼
                         Markdown + compact structuredContent
```

## Transport

- Node.js + TypeScript + Express + `@modelcontextprotocol/sdk` 1.29.0.
- `POST /mcp`만 지원하는 Streamable HTTP입니다. SSE 구독, GET stream, DELETE session은 제공하지 않습니다.
- `sessionIdGenerator`를 두지 않아 세션 ID를 만들거나 검사하지 않는 stateless 구성입니다.
- 요청마다 서버와 transport를 새로 만들고 응답이 닫히면 정리합니다. 사용자별 상태를 메모리에 이어 붙이지 않습니다.
- MCP 응답은 Streamable HTTP의 direct JSON response를 사용합니다.

## 결정적 큐레이션

1. 한·영 동의어를 12개의 canonical mood로 정규화합니다.
2. 각 mood를 `valence`, `energy`, `acousticness` 3차원 벡터로 매핑합니다.
3. 각 단계 안에서도 전역 슬롯별 진행률을 만들고 보간 벡터를 계산합니다.
4. 벡터 거리, 경로 투영, mood tag, 날씨, 활동, familiarity 방향, 아티스트 다양성, 곡 길이를 점수화합니다.
5. 시간 예약과 bounded beam search로 전체 순서를 함께 선택하고, 곡 투영과 단계 중심이 목표 방향으로 역행하지 않도록 제한합니다.
6. 점수와 안정 ID로 정렬해 입력이 같으면 곡과 순서가 같습니다. 12개 기분의 서로 다른 132개 조합을 회귀 테스트합니다.

점수 필드는 공식 스트리밍 서비스 지표가 아니라 자체 편집 추정치입니다. 추천은 의료적 처치가 아닌 음악 큐레이션입니다.

## 날씨 경로

- 허용 origin은 `https://geocoding-api.open-meteo.com`과 `https://api.open-meteo.com` 두 개로 코드에 고정합니다.
- 주요 국내 8개 도시는 내장 좌표로 forecast만 호출하고, 다른 도시는 geocode와 forecast를 순차 호출합니다.
- 전체 외부 요청은 2,600ms의 단일 deadline을 공유합니다.
- redirect를 거부하고 응답 shape와 finite number를 확인합니다.
- 성공 결과만 최대 256개·10분 LRU in-memory cache에 보관하고 동일 도시 동시 호출을 병합합니다.
- 인스턴스별 upstream 호출은 분당 100회로 제한합니다.
- timeout, 네트워크 오류, 도시 미발견, 잘못된 응답은 모두 `unknown` 중립 날씨로 폴백합니다.
- 출력 Markdown과 `structuredContent`에 Open-Meteo 데이터의 자체 분류·가공 사실과 CC BY 4.0 링크를 포함합니다.

## 결과 계약

Markdown은 단계, 곡 표기, 길이, 단계별 이유, 검색 링크를 순서대로 담습니다. `structuredContent`는 journey ID, 단계별 track ID, 요청·예상 시간, 방법론 note와 최소 날씨 정보만 담습니다. 음원, 가사, 커버 이미지, 재생 URL은 반환하지 않습니다.
