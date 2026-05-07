# PROLL — Minecraft Java 모바일 채팅 클라이언트

자바에디션 1.21 서버에 **모바일에서 직접 접속**해 채팅과 명령어를 주고받는 ChatCraft 스타일 앱.

각 앱 유저는 **본인의 마이크로소프트(정품) 계정**으로 로그인하고, 헤드리스 mineflayer 세션을 통해 **자기 명의의 플레이어**로 서버에 join 한다. 즉 디스코드처럼 자기 닉네임으로 채팅이 이뤄진다.

## 모노레포 구성

| 디렉토리 | 설명 |
| --- | --- |
| [`bridge/`](./bridge) | Node.js + TypeScript WebSocket 게이트웨이. 유저별 mineflayer 세션 매니저. Fly.io 등에 배포. |
| [`apps/mobile/`](./apps/mobile) | React Native + Expo 앱. MS 디바이스 코드 로그인 + 채팅 UI. |

## 빠른 시작 (로컬)

```bash
# 1. 루트에서 의존성 설치
npm install

# 2. 브릿지 환경 설정
cp bridge/.env.example bridge/.env
# bridge/.env 에 MC_HOST, MC_PORT, MC_VERSION 등 채우기

# 3. 브릿지 실행
npm run bridge:dev

# 4. 다른 터미널에서 모바일 앱
npm run mobile:start
# → Expo Go 앱으로 QR 스캔
```

## 아키텍처

```
[모바일 앱]  ──WSS──▶  [브릿지]  ──MC Java──▶  [마크 서버]
                          │
                          └─ 유저별 mineflayer 봇
                             (각자 본인 MS 계정으로 로그인)
```

자세한 설계는 `bridge/README.md`, `apps/mobile/README.md` 참고.

## 라이선스 / 약관 주의

- 본인 운영 서버 또는 본인이 허락받은 서버에서만 사용. 다른 서버의 운영 정책상 봇 클라이언트가 금지될 수 있다.
- 마이크로소프트 토큰은 브릿지의 영구 볼륨에 보관되며 외부로 전송되지 않는다.
