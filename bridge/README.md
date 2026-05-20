# bridge — Minecraft Java WebSocket 게이트웨이

각 앱 유저가 본인의 Microsoft 계정으로 마크 서버에 join 하도록 도와주는 WebSocket 서버.

## 동작

1. 앱이 WSS로 붙어 `{type:"auth_start"}` 전송
2. 브릿지가 `prismarine-auth`로 마이크로소프트 디바이스 코드 발급 → `{type:"auth_code",code,verificationUri}` 응답
3. 사용자가 폰 브라우저로 `microsoft.com/link`에서 코드 입력 → 토큰 획득
4. 브릿지가 그 토큰으로 mineflayer 봇을 띄워 마크 서버에 join (사용자 IGN으로 표시됨)
5. 이후 `{type:"send",text:"..."}`는 사용자 명의로 인게임에 채팅/명령어로 전송

## 환경변수

`bridge/.env.example` 참고. 핵심:

| 변수 | 설명 |
| --- | --- |
| `MC_HOST` / `MC_PORT` / `MC_VERSION` | 대상 마크 서버 |
| `SERVER_PROFILES` | 선택 사항. 여러 서버를 JSON 배열로 정의. 없으면 `rudulgi` 단일 프로필이 `MC_*` 값으로 자동 생성됨 |
| `WS_PORT` | WebSocket(+HTTP) 포트, `/health` 엔드포인트 동일 포트 |
| `BRIDGE_TOKEN` | 공개 브릿지에서는 필수. 설정 시 `Authorization: Bearer ...` 또는 `ws://host:port?token=...`로만 접속 허용 |
| `TOKENS_DIR` | 유저별 토큰 캐시 폴더 (운영 시 영구 볼륨) |
| `ALLOWED_ORIGINS` | WS Origin 화이트리스트(콤마 구분, 비우면 전체 허용) |
| `MAX_SESSIONS` | 동시 봇 수 상한 |
| `CHAT_RATE_LIMIT` | 유저당 초당 채팅 횟수 |

## 실행

```bash
npm install
cp .env.example .env
# .env 채우기
npm run dev
```

다중 서버 준비 예시:

```ini
SERVER_PROFILES=[{"id":"rudulgi","name":"루둘기","host":"99999.kr","port":25565,"version":"1.21.11","publicAddress":"99999.kr"},{"id":"nspring","name":"Nspring","host":"nspring.kr","port":25565,"version":"1.21.4","publicAddress":"nspring.kr"},{"id":"nef","name":"NEF","host":"nef.kr","port":25565,"version":"1.21.4","publicAddress":"nef.kr"}]
```

현재 PWA는 일반 유저에게 `rudulgi`만 노출한다. 다른 서버는 운영자가 앱 UI를
열기 전까지 브릿지 프로필로만 준비해 둘 수 있다.

WS 클라이언트로 빠르게 테스트:
```bash
npx wscat -c 'ws://localhost:8080?token=change-this-long-random-token'
> {"type":"auth_start"}
< {"type":"auth_code","code":"ABC-DEFGH","verificationUri":"https://www.microsoft.com/link","expiresInSec":900}
# 브라우저에서 코드 입력 후 잠시 기다리면…
< {"type":"auth_ok","userId":"YourIGN","ign":"YourIGN","uuid":"..."}
< {"type":"status","connected":true,...}
> {"type":"send","text":"안녕!"}
# 인게임에 본인 명의로 채팅됨
```

## 배포

- 맥미니 + Cloudflare Tunnel 운영 주소: `https://bridge.proit.kr/health`, `wss://bridge.proit.kr?token=<BRIDGE_TOKEN>`.
- 맥미니 운영은 `bridge/ops/macmini/README.md` 참고.
- Fly.io 배포도 가능 (영구 볼륨이 토큰 캐시에 적합).
- `Dockerfile`과 `fly.toml` 동봉.
- `flyctl secrets set MC_HOST=... MC_PORT=... MC_VERSION=... BRIDGE_TOKEN=... ALLOWED_ORIGINS=...`
- `flyctl volumes create bridge_tokens --size 1`
- `fly.toml`의 `[mounts]`가 볼륨을 `/data`에 마운트, `TOKENS_DIR=/data/tokens` 사용.

## 운영 상태 확인

- 공개 liveness: `GET /health`
- 로컬 전용 JSON: `GET /admin/status`
- 로컬 전용 대시보드: `GET /admin/dashboard`

`/admin/status`와 `/admin/dashboard`는 SSH 터널 또는 맥미니 로컬 브라우저에서만
토큰 없이 열린다. Cloudflare Tunnel 같은 외부 프록시를 거치거나 `bridge.proit.kr`로
직접 접근하면 `404`를 반환한다. 대시보드는 운영자 점검용이며 일반 유저에게
노출하지 않는다.

대시보드는 활성 WebSocket, 활성 세션/계정, 재접속/세션 재사용, 최근 킥/오류,
메모리 RSS 추이를 5초 간격으로 갱신한다.

## 보안 메모

- 토큰은 절대 git/로그에 노출되지 않음. `.gitignore`에 `bridge/tokens/` 포함.
- `BRIDGE_TOKEN`을 설정하면 캐시된 IGN만 알고 세션에 붙는 공격을 막을 수 있음.
- `ALLOWED_ORIGINS`로 우리 앱 외 접근 차단 권장.
- `CHAT_RATE_LIMIT`과 `MAX_SESSIONS`로 악용 방지.
- PWA에 query token을 넣는 방식은 배포가 단순하지만 번들에서 추출 가능하다. 운영 보안을 더 올릴 때는 짧은 수명의 사용자별 앱 토큰 발급 계층을 추가한다.
