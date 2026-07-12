# PlayMCP 등록·심사 입력안

아래 문구는 콘솔에 그대로 붙여 넣을 수 있는 초안입니다. 배포가 Active가 된 뒤 `<PUBLIC_HTTPS_ENDPOINT>`만 실제 값으로 바꿉니다.

## MCP 서버 등록

| 필드 | 입력값 |
| --- | --- |
| 대표 이미지 | `assets/moodtransit-icon.png` (1254×1254 PNG) |
| MCP 이름 | `기분환승` |
| MCP 식별자 | `moodtransit` |
| 인증 방식 | `인증 사용하지 않음` |
| MCP Endpoint | `<PUBLIC_ENDPOINT>/mcp` |

### MCP 설명

```text
기분환승은 현재 기분을 억지로 덮지 않고, 원하는 기분까지 Mirror→Bridge→Arrive 3단계 음악 경로를 설계합니다. 현재·목표 감정의 에너지/정서 좌표를 보간하고 실제 날씨·활동·가용시간·언어/연주곡 선호를 반영해 곡 순서와 총 시간을 계산합니다. ‘더 차분하게/더 밝게’ 같은 피드백을 받으면 이전 곡을 제외하고 다시 점수화합니다. 음원·가사·개인정보를 저장하지 않으며 검색 링크만 제공합니다. 날씨: Open-Meteo(CC BY 4.0).
```

### 대화 예시 3개

```text
퇴근길 울적함에서 희망으로 25분 기분환승
```

```text
서울 날씨와 산책에 맞는 20분 연주곡 여정
```

```text
방금 곡은 빼고 더 밝고 익숙하게 다시 짜줘
```

## 도구 심사 설명 요약

- `build_mood_journey`: 외부 통신 없이 curated metadata만 사용하고 같은 입력에는 같은 순서를 반환합니다.
- `build_weather_journey`: Open-Meteo 고정 도메인만 사용합니다. 주요 국내 도시는 외부 호출 1회, 전체 2.6초 deadline, 최대 256개·10분 LRU cache, 동시 호출 병합, upstream 요청 예산, 실패 시 중립 fallback을 적용합니다. 자체 분류·가공 사실과 CC BY 4.0 링크를 출력합니다.
- `refine_mood_journey`: 이전 기분·시간·맥락과 track ID를 명시적으로 받아 이전 곡은 제외합니다. familiar/discovery는 감정 경로를 보존하고 방향 피드백만 목표 축을 조정합니다. 서버는 이전 여정을 저장하지 않습니다.
- 모든 도구는 읽기 전용, 비파괴, 광고·결제·인증·개인정보 수집이 없습니다.
- 곡 energy/valence 등은 자체 편집 추정치이고 치료 효과를 주장하지 않습니다.

## 정보 불러오기 전 점검

1. PlayMCP in KC에서 container port를 `8000`으로 설정합니다.
2. 배포 상태가 Active인지 확인합니다.
3. `GET https://<PUBLIC_HTTPS_ENDPOINT>/`, `/healthz`, `/readyz`가 모두 200인지 확인합니다.
4. `MCP_URL=https://<PUBLIC_HTTPS_ENDPOINT>/mcp npm run smoke`가 tools 3개와 calls `ok`를 출력하는지 확인합니다.
5. smoke 출력의 `weather.source`가 `open-meteo`인지 별도로 확인합니다. 일시적 fallback이면 네트워크 상태 확인 후 다시 실행합니다.
6. 콘솔 Endpoint에 반드시 `/mcp`를 포함하고 “정보 불러오기”를 누릅니다.
7. 불러온 tool이 정확히 3개이고 각 tool의 name, title, description, inputSchema, annotations가 보이는지 확인합니다.
8. 먼저 임시 등록하고 도구함/AI 채팅에서 위 대화 예시를 실행합니다.
9. 결과가 Mirror → Bridge → Arrive 순서이고 검색 링크가 search URL인지 확인한 뒤 심사 요청합니다.

## 비즈니스폼용 요약

### 서비스 소개 및 지원 사유 (200자 이내)

```text
기분환승은 현재 기분과 비슷한 곡만 나열하지 않고, 목표 기분까지 ‘공감→전환→도착’ 3단계로 이어지는 시간 제한형 음악 경로를 만듭니다. 실제 날씨·활동·가용시간과 피드백을 계산해, 카카오톡 대화 한 번으로 일상에서 반복 사용 가능한 기분 전환 경험을 제공하고자 지원합니다.
```

### 차별점

```text
단순 기분 매칭이나 즉시 반전 추천이 아니라 Mirror(현재 인정), Bridge(중간 전환), Arrive(목표 도착)의 설명 가능한 순서를 만듭니다. 모든 선택은 검증된 실제 곡 메타데이터와 결정적 점수로 재현 가능하며, 날씨 조회가 늦거나 실패해도 2.6초 안에 중립 폴백해 여정을 완성합니다.
```

### 데이터·안전

```text
음원·가사·앨범아트를 저장하거나 전송하지 않고 title+artist 기반 음악 서비스 검색 링크만 제공합니다. 도시명은 로그나 디스크에 저장하지 않으며 최대 256개·10분 LRU 메모리 캐시만 사용합니다. 광고·구독·API 키·사용자 계정이 없고, 음악 큐레이션일 뿐 의료·심리 치료 효과를 주장하지 않습니다. 날씨는 Open-Meteo 데이터의 분류·가공 사실과 CC BY 4.0 링크를 결과에 표시합니다.
```

## 최종 제출 체크리스트

- [ ] 대표 이미지가 권장 600×600 이상이고 콘솔에서 선명하게 보임
- [ ] server name과 3개 tool name에 대소문자 무관 `kakao`가 없음
- [ ] 공개 HTTPS endpoint 및 `/mcp` 경로 확인
- [ ] `npm audit`, typecheck, test, build, smoke, benchmark 통과
- [ ] `linux/amd64` Docker 실행과 `/healthz` 확인
- [ ] 실제 weather smoke가 `source=open-meteo` 반환
- [ ] 임시 등록 후 AI 채팅에서 3개 예시 직접 확인
- [ ] 설명·structuredContent의 편집 추정치 및 Open-Meteo attribution 확인
- [ ] 심사 요청 후 승인 상태 확인
- [ ] 승인 뒤 공개 범위 설정 및 비즈니스폼 최종 제출
