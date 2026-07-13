# PlayMCP 등록·심사 입력안 — MoodTransit v2.3

아래 문구는 콘솔에 그대로 붙여 넣을 수 있는 최종 초안입니다. PlayMCP in KC 배포가 `Active`가 된 뒤 `<PUBLIC_HTTPS_ENDPOINT>`만 실제 HTTPS 주소로 바꿉니다.

## MCP 서버 등록

| 필드 | 입력값 |
| --- | --- |
| 대표 이미지 | `assets/moodtransit-icon.png` (1254×1254 PNG) |
| MCP 이름 | `기분환승` |
| MCP 식별자 | `moodtransit` |
| 인증 방식 | `인증 사용하지 않음` |
| MCP Endpoint | `<PUBLIC_HTTPS_ENDPOINT>/mcp` |

### MCP 설명 — 500자 이하

```text
기분환승은 자유롭게 말한 기분·비유·날씨·활동·원하는 소리 질감을 연속 감정 좌표와 동적 음악 태그로 해석해 Mirror→Bridge→Arrive 3단계 음악 여정을 만듭니다. 12개 감정은 입력 제한이 아니라 표시용 기준점입니다. ListenBrainz·MusicBrainz 공개 후보와 명시한 가수·곡을 검색하고, 공식 Melon MCP 후보도 ID·URL을 보존해 재배열합니다. 결과에 실제 후보 범위와 의미 해석·조건 일치 수준을 밝히며, 67곡은 공개 경로 장애나 후보 부족 시에만 사용합니다. 검색 링크는 전체 카탈로그 접근이나 재생 가능 여부를 뜻하지 않습니다.
```

### 대화 예시 3개 — 각각 40자 이하

```text
오늘 너무 더운데 시원한 노래 틀어줘
```

```text
퇴근길인데 축 처져, 기분 좀 올려줘
```

```text
머릿속이 복잡해, 생각 정리되는 노래 틀어줘
```

각 예시는 40자 이하입니다.

## 도구 심사 설명 요약

- `build_live_mood_journey`: 다른 음악 MCP의 후보가 없을 때 사용합니다. 전체 사용자 문장을 `requestText`로 보존하고, 가능하면 `semanticIntent`의 연속 current/target 좌표와 짧은 영어 검색·제외 태그를 함께 전달합니다. 의미 필드가 빠져도 서버가 원문에서 부정되지 않은 기분·감각 표현과 전용 날씨·활동 필드만 고정 허용 태그로 보완해 실패 없이 처리합니다. 의미 신호를 확인할 수 없으면 임의 추측 없이 `canonical_fallback`을 표시합니다. 서버는 연속 좌표로 실제 3단계 경로를 계산하며, 선택 곡 메타데이터에서 확인하지 못한 동적 태그는 `unmatchedSemanticTags`와 `contextMatchMode=broadened`로 표시합니다.
- `arrange_candidate_mood_journey`: 공식 Melon MCP나 사용자가 활성화한 YouTube Data MCP 등 음악 도구가 먼저 반환한 3~20개 후보만 재배열합니다. Melon 요청은 `search_melon_music_contents`, YouTube 요청은 `search_videos` 또는 `search_playlists`로 실제 후보를 먼저 받은 뒤 title, artist, 공급자 ID, 정규화된 URL, 원래 순위를 보존해 전달합니다. 기분환승이 해당 공급자의 전체 카탈로그에 직접 접근했다고 주장하지 않습니다.
- `refine_mood_journey`: 앞선 결과의 `structuredContent.refinementState`를 그대로 받아 밝기·에너지·익숙함/발견·시간·제외곡·회피 아티스트를 반영합니다. `live_open_catalog`이면 공개 후보를 다시 조회할 수 있고, `provided_candidates`이면 상태값 안의 압축된 공급자 후보 묶음 밖의 곡을 추가하지 않습니다. 서버에 사용자별 대화 상태를 저장하지 않습니다.
- 세 도구는 모두 읽기 전용·비파괴이며 음원·가사·앨범아트를 반환하거나 저장하지 않습니다. 계정, 개인 청취 기록, API 키, OAuth token을 수집하지 않습니다.
- 3단계 감정 경로와 점수는 기분환승의 편집적 계산이며 공급자의 공식 추천 순위·공식 음향 특성·치료 효과가 아닙니다.

## 결과 범위 표기

모든 정상 결과의 `structuredContent.selectionScope`를 확인합니다.

| `kind` | 실제 의미 | 표시해야 할 한계 |
| --- | --- | --- |
| `public_open_catalog` | 이번 요청에 사용한 ListenBrainz·MusicBrainz 공개 후보(같은 조건은 10분 캐시 가능) | MusicBrainz는 대규모 커뮤니티 카탈로그이나 전 세계 모든 발매를 보장하지 않음 |
| `provided_candidate_batch` | 다른 MCP가 이번 대화에서 전달한 후보 묶음 | 해당 공급자의 전체 카탈로그 조회 결과가 아님 |
| `curated_fallback` | 공개 경로 장애·후보 부족·필터 불충족 시에만 사용한 비상 후보 | 실시간 후보가 아니며 fallback 사유를 함께 표시 |

YouTube Music·Melon URL은 `title + artist`로 만든 검색 링크이며 해당 서비스의 전체 카탈로그 접근, 직접 재생 URL, 곡 존재나 재생 가능 여부를 의미하지 않습니다. 공급자가 URL을 전달한 선택 곡은 검색 링크 대신 실제 호스트명이 표시된 전달 링크를 보존합니다.

## 정보 불러오기 전 점검

1. PlayMCP in KC에서 container port를 `8000`으로 설정합니다.
2. 배포 상태가 `Active`인지 확인합니다.
3. `GET https://<PUBLIC_HTTPS_ENDPOINT>/`, `/healthz`, `/readyz`가 모두 HTTP 200인지 확인합니다.
4. 공개 endpoint를 대상으로 다음 검증을 실행합니다.

```powershell
$env:MCP_URL = "https://<PUBLIC_HTTPS_ENDPOINT>/mcp"
$env:REQUIRE_LIVE_CATALOG = "1"
npm run smoke
npm run benchmark:endpoint
```

`npm run smoke:catalog`는 `MCP_URL`을 사용하지 않고 로컬에서 ListenBrainz를 직접 확인하는 별도 upstream 진단입니다.

5. live smoke와 endpoint benchmark가 `selectionScope.kind=public_open_catalog`를 반환하는지 확인합니다. `curated_fallback` 또는 `fallbackReason`이 보이면 심사 요청을 진행하지 말고 해당 사유에 따라 ListenBrainz 연결·rate limit·deadline·후보 부족·요청 필터를 점검한 뒤 다시 실행합니다.
6. MCP Inspector로 `initialize`, `tools/list`와 세 도구 대표 호출을 실행하고 protocol `2025-03-26`, `2025-11-25`에서 오류가 없는지 확인합니다.
7. PlayMCP 콘솔 Endpoint에 `/mcp`를 포함한 주소를 입력하고 “정보 불러오기”를 누릅니다.
8. 불러온 도구가 정확히 아래 3개인지 확인합니다.
   - `build_live_mood_journey`
   - `arrange_candidate_mood_journey`
   - `refine_mood_journey`
9. 각 도구에 name, title, 영문 description, required input schema와 다섯 annotations가 모두 표시되는지 확인합니다.
10. 먼저 임시 등록한 뒤 PlayMCP 도구함과 AI 채팅에서 아래 세 흐름을 실제 실행합니다.

### AI 채팅 필수 검증

1. **자유 문장 + Live 공개 후보**
   - 첫 번째와 세 번째 대화 예시를 각각 실행합니다.
   - `build_live_mood_journey`가 호출되고 `public_open_catalog`가 반환되는지 확인합니다.
   - Tool Request에 사용자 문장 전체가 `requestText`로 보존되고 `semanticIntent`에 연속 좌표와 동적 검색 태그가 들어가는지 확인합니다.
   - 결과의 `interpretation.semanticCoverage=full`이며 `currentAxes`, `targetAxes`, `discoveryTags`가 표시되는지 확인합니다.
   - 별도 검증 문장 `리센느 노래로 지금 기분 좀 올려줘`도 실행합니다.
   - 요청 `리센느`가 `searchResolution.matchedArtists`의 `RESCENE`으로 해석되고, 결과 곡의 아티스트가 RESCENE인지 확인합니다.
   - `sources`에 ListenBrainz와 MusicBrainz가 있고 `curated_fallback`이 아닌지 확인합니다.
2. **공식 Melon MCP 후보 조합**
   - 공식 Melon MCP를 같은 도구함에 활성화하고 두 번째 예시를 실행합니다.
   - AI가 live 공개 검색을 선택하면 `멜론에서 퇴근길에 처진 기분을 올릴 노래 찾아줘`처럼 공급자를 명시해 다시 실행합니다.
   - AI가 먼저 공식 Melon MCP의 `search_melon_music_contents` 등 검색·추천 도구로 실제 후보를 받은 뒤 `arrange_candidate_mood_journey`에 전달하는지 확인합니다.
   - 결과가 `provided_candidate_batch`이고 Melon ID와 의미상 같은 정규화 URL이 보존되는지 확인합니다.
   - 결과 문구가 “Melon MCP가 반환한 후보 중 구성”이라고 밝히며 Melon 전체 카탈로그를 직접 조회했다고 표현하지 않는지 확인합니다.
3. **YouTube 검색 후보 조합**
   - 검토한 YouTube Data MCP를 같은 도구함에 활성화하고 세 번째 예시를 실행합니다.
   - AI가 live 공개 검색을 선택하면 `유튜브에서 머릿속 정리되는 노래 찾아줘`처럼 공급자를 명시해 다시 실행합니다.
   - AI가 먼저 `search_videos` 또는 `search_playlists`를 호출하고, 성공 시 실제 title·channel/artist·video ID·URL을 `arrange_candidate_mood_journey`에 전달하는지 확인합니다.
   - 외부 MCP의 일일 API quota가 소진되면 검색 실패를 그대로 알리고, 실제 YouTube 결과를 찾은 것처럼 꾸미지 않는지 확인합니다.
4. **피드백 refinement**
   - 위 결과에 이어 `방금 곡은 빼고 더 밝고 낯선 곡으로 다시 짜줘`를 실행합니다.
   - AI가 직전 `refinementState`를 바꾸지 않고 `refine_mood_journey`에 전달하는지 확인합니다.
   - `revision`이 증가하고 이전 `sourceMode`를 유지하며 요청한 제외곡·밝기·발견 성향이 반영되는지 확인합니다. `provided_candidates` mode에서는 전달 후보 범위도 유지되는지 확인합니다.

세 흐름 모두 Mirror → Bridge → Arrive 순서, 10~60분 입력 제한, 검색 링크와 전달 링크의 호스트명, 결과의 제한 고지를 함께 확인한 뒤 심사를 요청합니다.

## 비즈니스폼용 요약

### 서비스 소개 및 지원 사유 — 200자 / 200자 이하

```text
기분환승은 현재 기분에서 원하는 기분까지 ‘공감→전환→도착’ 3단계 음악 여정을 만듭니다. 고정 목록 대신 ListenBrainz·MusicBrainz 공개 후보를 동적으로 구성하고, 공식 Melon MCP 후보도 원본 링크를 보존해 재배열합니다. 선택 범위와 검색 링크 한계를 투명하게 밝혀 카카오톡에서 반복 가능한 기분 전환 경험을 제공하고자 지원합니다.
```

### 차별점

```text
단순히 비슷한 곡을 나열하거나 기분을 즉시 반전시키지 않고 Mirror(현재 공감), Bridge(점진 전환), Arrive(목표 도착)의 설명 가능한 순서를 만듭니다. 단독 사용에서는 공개 ListenBrainz·MusicBrainz 후보를 요청 조건에 맞게 구성하고, 공식 Melon MCP와 함께 사용할 때는 Melon이 반환한 개인화 후보만 원본 ID·URL 그대로 재배열합니다. 매 결과에 실제 후보 범위를 명시해 전체 카탈로그 접근처럼 과장하지 않습니다.
```

### 데이터·안전

```text
음원·가사·앨범아트를 저장하거나 전송하지 않습니다. ListenBrainz·MusicBrainz 공개 메타데이터와 사용자가 대화에서 명시한 취향만 사용하며 계정·개인 청취 기록·OAuth token을 저장하지 않습니다. YouTube Music·Melon 링크는 title+artist 검색용이고 재생 가능 여부를 보장하지 않습니다. 공식 Melon MCP 후보의 ID·URL은 전달받은 값만 보존합니다. 날씨는 필요할 때 Open-Meteo를 조회하고 출처·가공 사실을 표시합니다.
```

## 최종 제출 체크리스트

- [ ] 대표 이미지가 권장 600×600 이상이고 콘솔에서 선명하게 보임
- [ ] server name과 3개 tool name에 대소문자 무관 `kakao`가 없음
- [ ] MCP 이름 `기분환승`, 식별자 `moodtransit` 유지
- [ ] 공개 HTTPS endpoint와 `/mcp` 경로 확인
- [ ] `npm audit`, typecheck, test, build, smoke, catalog smoke, benchmark 통과
- [ ] `linux/amd64` Docker 실행, non-root user와 `/healthz` 확인
- [ ] 실제 live smoke가 `selectionScope.kind=public_open_catalog` 반환
- [ ] 실제 live smoke에서 `curated_fallback`과 `fallbackReason` 미사용
- [ ] 임시 등록 후 AI 채팅에서 live 공개 후보 흐름 확인
- [ ] 공식 Melon MCP → 실제 후보 → `arrange_candidate_mood_journey` 연속 호출 확인
- [ ] Melon 후보의 ID·정규화 URL 보존과 `provided_candidate_batch` 확인
- [ ] refinement가 직전 `refinementState`와 `sourceMode`를 보존하고 provided mode에서 후보 범위를 유지하는지 확인
- [ ] 검색 링크가 존재·재생 가능성을 보장하지 않고 공급자 전달 링크는 실제 호스트명을 표시함
- [ ] 설명·결과·AI 답변 어디에도 YouTube·YouTube Music·Melon 전체 카탈로그 접근 주장이 없음
- [ ] ListenBrainz·MusicBrainz·Open-Meteo 출처와 데이터 조건 고지 확인
- [ ] 세 도구의 annotations와 입력 제한 확인
- [ ] 심사 요청 후 승인 상태 확인
- [ ] 승인 뒤 공개 범위 설정 및 비즈니스폼 최종 제출
