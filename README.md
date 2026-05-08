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

## 맥에서 로컬 테스트 (iOS 시뮬레이터 + vanilla 서버)

가장 빠르게 풀스택을 검증하는 흐름. 같은 머신에 마크 서버, 브릿지, 시뮬레이터가 모두 있어 LAN IP를 신경 쓸 필요 없이 `localhost`로 통한다.

### 사전 준비 (한 번만)

- **Xcode**: App Store에서 설치 후 한 번 실행해 라이선스 동의. iOS Simulator 포함됨.
- **Java 21+**: `brew install --cask temurin` 등.
- **Node.js 20+**, `npm`.
- **Minecraft Java 서버 jar**: [minecraft.net/download/server](https://www.minecraft.net/en-us/download/server)에서 1.21.x `server.jar` 다운로드 (전용 폴더에 둘 것).

### 1) 로컬 마크 서버 부팅

```bash
mkdir -p ~/mc-test-server && cd ~/mc-test-server
# server.jar를 이 폴더에 넣고
java -Xmx2G -jar server.jar nogui
# → eula.txt 생성됨. eula=true 로 수정.
java -Xmx2G -jar server.jar nogui
# 콘솔에서:
#   whitelist on
#   whitelist add <본인의 마크 IGN>
#   op <본인의 마크 IGN>      # (선택) 명령어 테스트용
```

`server.properties`에서 `online-mode=true` 그대로 두고(정품 인증 살림) `server-port=25565` 확인.

### 2) 브릿지 설정 + 실행

```bash
cd <레포 루트>
npm install
cp bridge/.env.example bridge/.env
```

`bridge/.env` 편집:

```ini
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.21.4   # 본인 server.jar 버전과 일치시킬 것
WS_PORT=8080
TOKENS_DIR=./tokens
```

```bash
npm run bridge:dev
# [bridge] listening on ws://localhost:8080
```

### 3) iOS 시뮬레이터에서 앱 실행

다른 터미널에서:

```bash
open -a Simulator     # 시뮬레이터 미리 띄워두면 Expo가 자동으로 그걸 사용
npm run mobile:start
# 메뉴에서 'i' → iOS 시뮬레이터에 Expo Go + 앱 자동 설치
```

### 4) 시뮬레이터 안에서

1. **Bridge URL** 입력 화면 — dev 빌드라 `ws://localhost:8080`이 자동으로 채워져 있음. 그대로 Continue.
2. **Sign in with Microsoft** → 디바이스 코드 표시.
3. "링크 열기" 누르면 시뮬 안 사파리에서 microsoft.com/link 페이지 열림. 코드 입력 → 본인 MS 계정 로그인.
4. 로그인 완료되면 자동으로 채팅 화면 진입. 마크 서버 콘솔에 `<본인IGN> joined the game` 로그 확인.
5. 채팅 입력해보고, 데스크탑 마크 클라이언트로 같은 서버에 접속해 양방향 채팅이 보이는지 검증.

### 자주 막히는 곳

- **버전 미스매치**: `MC_VERSION`이 server.jar 버전과 다르면 join 실패. mineflayer는 정확한 프로토콜을 기대함.
- **whitelist**: 켜놓고 IGN 추가 안 했으면 즉시 킥됨 (`You are not whitelisted on this server`).
- **이미 로그인된 본인 클라이언트**: 마크는 같은 계정 동시 접속 불가. 봇이 join하려면 데스크탑 마크 클라이언트는 닫아둘 것 (또는 봇이 들어가 있을 때 데스크탑으로 join하면 봇이 튕긴다).
- **포트 충돌**: 이미 다른 게 8080을 쓰고 있으면 `WS_PORT=8090`으로 변경하고 시뮬에서도 그 URL로.
- **시뮬 사파리에서 MS 로그인 막힘**: 가끔 `aka.ms/AAxxxxxx` 단축 URL이 시뮬에서 부드럽지 않음. 그땐 코드를 복사해서 맥의 사파리/크롬에서 microsoft.com/link 직접 열어 입력해도 됨.
- **Android 에뮬레이터로 테스트**: `localhost` 대신 `ws://10.0.2.2:8080` (앱이 자동 설정).

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
