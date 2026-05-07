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
| `WS_PORT` | WebSocket(+HTTP) 포트, `/health` 엔드포인트 동일 포트 |
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

WS 클라이언트로 빠르게 테스트:
```bash
npx wscat -c ws://localhost:8080
> {"type":"auth_start"}
< {"type":"auth_code","code":"ABC-DEFGH","verificationUri":"https://www.microsoft.com/link","expiresInSec":900}
# 브라우저에서 코드 입력 후 잠시 기다리면…
< {"type":"auth_ok","userId":"YourIGN","ign":"YourIGN","uuid":"..."}
< {"type":"status","connected":true,...}
> {"type":"send","text":"안녕!"}
# 인게임에 본인 명의로 채팅됨
```

## 배포

- Fly.io 권장 (영구 볼륨이 토큰 캐시에 적합).
- `Dockerfile`과 `fly.toml` 동봉.
- `flyctl secrets set MC_HOST=... MC_PORT=... MC_VERSION=... ALLOWED_ORIGINS=...`
- `flyctl volumes create bridge_tokens --size 1`
- `fly.toml`의 `[mounts]`가 볼륨을 `/data`에 마운트, `TOKENS_DIR=/data/tokens` 사용.

## 보안 메모

- 토큰은 절대 git/로그에 노출되지 않음. `.gitignore`에 `bridge/tokens/` 포함.
- `ALLOWED_ORIGINS`로 우리 앱 외 접근 차단 권장.
- `CHAT_RATE_LIMIT`과 `MAX_SESSIONS`로 악용 방지.
