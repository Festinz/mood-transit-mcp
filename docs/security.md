# Security and privacy

## 데이터 최소화

- 계정, 쿠키, 전화번호, 이메일, 정확한 좌표, 광고 ID를 입력받지 않습니다.
- API 키, OAuth, custom header, secret이 필요하지 않습니다.
- 요청이나 도시명을 application log에 기록하지 않습니다.
- `build_weather_journey`의 도시명과 조회 결과는 프로세스 메모리에서만 최대 256개·10분 LRU cache에 보관하고, 디스크나 외부 데이터베이스에 persist하지 않습니다.
- 캐시는 프로세스 재시작과 함께 사라집니다.
- 곡 취향 이력과 이전 여정은 서버가 보관하지 않습니다. refine은 호출자가 보낸 bounded track ID와 이전 기분·시간·맥락만 사용합니다.

## 입력과 프로토콜 경계

- HTTP JSON body는 64 KiB로 제한합니다.
- 모든 도구 schema는 strict object이며 문자열 길이, 배열 수, 정수 범위, enum을 제한합니다.
- `minutes`는 10~60, `avoidArtists`는 12개, `previousTrackIds`는 24개가 최대입니다.
- 예상하지 않은 object key는 거부합니다.
- stateless transport라 session fixation과 서버측 session store가 없습니다.
- `Origin` 헤더가 있으면 명시 allowlist 또는 같은 loopback origin만 허용하고, 그 밖의 값은 403으로 거부합니다. 서버 간 MCP 요청처럼 `Origin`이 없으면 허용합니다.
- 서버와 tool name에는 금지 문자열을 포함하지 않으며 자동 테스트로 검사합니다.

## 외부 요청과 SSRF 방어

- 사용자 입력은 URL origin/path를 결정하지 않고 query parameter인 city에만 들어갑니다.
- 코드가 허용하는 HTTPS origin은 Open-Meteo의 geocoding/forecast 두 개뿐입니다.
- redirect는 거부합니다.
- 외부 요청 전체 deadline은 2,600ms이며 실패 시 외부 재시도 없이 중립 폴백합니다.
- 성공 결과는 최대 256개·10분 LRU cache에 두고 동일 도시 동시 호출을 병합합니다.
- 인스턴스별 upstream 호출 예산은 분당 100회이며 소진 시 중립 폴백합니다.

## 콘텐츠 원칙

- 카탈로그에는 사실 메타데이터와 자체 편집 추천 추정치만 있습니다.
- 음원 파일, 가사, 앨범 아트, 직접 재생 URL을 저장·전송하지 않습니다.
- 검색 링크는 고정된 음악 서비스 search URL에 title+artist를 encode해서 만듭니다.
- 광고, 제휴 추적 parameter, 결제·구독 유도가 없습니다.
- 음악 큐레이션일 뿐, 우울·불안 등을 진단하거나 의료·정서 치료 효능을 주장하지 않습니다.

## 운영 권고

- 공개 배포에서는 TLS가 제공되는 플랫폼 endpoint를 사용합니다.
- Docker 컨테이너는 non-root `node` 사용자로 실행합니다.
- 플랫폼에서 CPU/메모리/request concurrency 제한을 설정하고 `/healthz`, `/readyz`를 감시합니다.
- 상용화 전에 Open-Meteo paid 또는 self-host 조건과 attribution을 다시 확인합니다.
