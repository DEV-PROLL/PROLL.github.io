# PROLL — Minecraft Java 모바일 채팅 클라이언트

자바에디션 1.21 서버에 **모바일에서 직접 접속**해 채팅과 명령어를 주고받는 ChatCraft 스타일 앱.

각 앱 유저는 **본인의 마이크로소프트(정품) 계정**으로 로그인하고, 헤드리스 mineflayer 세션을 통해 **자기 명의의 플레이어**로 서버에 join 한다. 즉 디스코드처럼 자기 닉네임으로 채팅이 이뤄진다.

## 모노레포 구성

| 디렉토리 | 설명 |
| --- | --- |
| [`bridge/`](./bridge) | Node.js + TypeScript WebSocket 게이트웨이. 유저별 mineflayer 세션 매니저. Fly.io 등에 배포. |
| [`apps/mobile/`](./apps/mobile) | React Native + Expo 앱. iOS/iPadOS/Android/웹(PWA) 공용 채팅 UI. |

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

## 웹/PWA 빌드와 배포

App Store 심사 없이 iPhone, iPad, Android, macOS에서 먼저 쓰기 위해 Expo Web 정적 빌드를 지원한다. iPhone/iPad는 Safari의 **공유 → 홈 화면에 추가**, Android는 Chrome의 **앱 설치** 또는 **홈 화면에 추가**로 앱처럼 설치할 수 있다.

```bash
# 타입체크 + 정적 웹 산출물 생성
npm run typecheck -w mobile
npm run web:export

# 로컬 확인
python3 -m http.server 19006 --directory apps/mobile/dist
# http://localhost:19006
```

GitHub Pages 배포는 `.github/workflows/deploy-web.yml`이 처리한다. `main` 브랜치에 push하면 `apps/mobile/dist`를 Pages artifact로 배포한다. GitHub 저장소 설정에서 Pages source를 **GitHub Actions**로 선택해야 한다.

운영 웹 배포는 HTTPS에서 뜨므로 브릿지도 반드시 `wss://...`로 접근 가능해야 한다. 현재 운영 브릿지는 Cloudflare Tunnel을 통해 `https://bridge.proit.kr/health`와 `wss://bridge.proit.kr`로 노출한다. `ws://` 로컬 브릿지는 개발용 또는 같은 사설망 테스트용이다.

일반 유저에게 브릿지 주소를 숨기려면 웹 빌드 시 공개 환경변수로 기본 브릿지 호스트만 주입한다:

```bash
EXPO_PUBLIC_BRIDGE_URL="wss://bridge.proit.kr" npm run web:export
```

이 값이 있으면 앱 첫 화면은 `99999.kr` 서버 주소 중심으로 동작하고, 브릿지 입력은 고급 설정으로만 남는다. PWA는 접속 직전에 `https://bridge.proit.kr/client-ticket`에서 1회용 짧은 수명의 티켓을 받아 `wss://bridge.proit.kr?ticket=...`로 연결한다. 운영 빌드에 장기 `BRIDGE_TOKEN`을 넣지 않는다.

GitHub Pages 자동 배포에서는 저장소 Settings → Secrets and variables → Actions → Variables에 `EXPO_PUBLIC_BRIDGE_URL=wss://bridge.proit.kr` 값을 추가한다. 실제 `BRIDGE_TOKEN`은 맥미니의 `/Users/podo/PROLL.github.io/bridge/.env` 안에만 두고, README/커밋/웹 번들에는 남기지 않는다.

이동 패널의 로드된 청크 미니맵은 공개 변수 `EXPO_PUBLIC_MAP_ENABLED=true`와
브릿지의 비공개 운영 설정 `MAP_ENABLED=true`를 함께 켰을 때만 구독한다.
`MAP_MAX_SUBSCRIBERS` 기본값은 `2`이며 토큰이나 장기 자격 증명은 Expo 변수로
전달하지 않는다.

정적 export 후 `apps/mobile/scripts/prepare-web-dist.mjs`는 GitHub Pages 호환을 위해 `.nojekyll`을 만들고, Expo 번들을 루트 `app.js?v=<bundle-hash>`로 복사한다. 배포 후 오래된 홈 화면 앱이 갱신되지 않으면 Safari/Chrome에서 새로고침하거나 홈 화면 앱을 다시 추가한다.

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
MC_VERSION=1.21.11  # 본인 server.jar 버전과 일치시킬 것
WS_PORT=8080
BRIDGE_TOKEN=원하는_긴_토큰
TOKENS_DIR=./tokens
SESSION_GRACE_MS=1800000
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

1. **Bridge URL** 입력 화면 — dev 기본값 `ws://localhost:8080` 그대로 Continue. 앱은 `/client-ticket`을 호출해 1회용 티켓으로 WebSocket에 붙는다. 수동 WebSocket 클라이언트로 테스트할 때만 `ws://localhost:8080?token=원하는_긴_토큰` 형식을 사용한다.
2. **Sign in with Microsoft** → 디바이스 코드 표시.
3. "링크 열기" 누르면 시뮬 안 사파리에서 microsoft.com/link 페이지 열림. 코드 입력 → 본인 MS 계정 로그인.
4. 로그인 완료되면 자동으로 채팅 화면 진입. 마크 서버 콘솔에 `<본인IGN> joined the game` 로그 확인.
5. 채팅 입력해보고, 데스크탑 마크 클라이언트로 같은 서버에 접속해 양방향 채팅이 보이는지 검증.

### 자주 막히는 곳

- **버전 미스매치**: `MC_VERSION`이 server.jar 버전과 다르면 join 실패. mineflayer는 정확한 프로토콜을 기대함.
- **whitelist**: 켜놓고 IGN 추가 안 했으면 즉시 킥됨 (`You are not whitelisted on this server`).
- **이미 로그인된 본인 클라이언트**: 마크는 같은 계정 동시 접속 불가. 봇이 join하려면 데스크탑 마크 클라이언트는 닫아둘 것 (또는 봇이 들어가 있을 때 데스크탑으로 join하면 봇이 튕긴다).
- **포트 충돌**: 이미 다른 게 8080을 쓰고 있으면 `WS_PORT=8090`으로 변경하고 시뮬에서도 그 URL로.
- **실제 iPhone 테스트**: iPhone은 Mac의 `localhost`를 볼 수 없음. 같은 Wi-Fi에서 Mac IP를 확인한 뒤 `ws://192.168.x.x:8080` 형태로 입력. 로컬 브릿지에 `ALLOWED_ORIGINS`를 엄격하게 걸어두면 네이티브/Expo 개발 클라이언트의 Origin이 없어 티켓 발급이 막힐 수 있으니 개발 중에는 비워둔다.
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
- `BRIDGE_TOKEN` 없이 브릿지를 공개망에 열지 말 것. 운영 배포는 반드시 `wss://`, `ALLOWED_ORIGINS`, `/client-ticket` 기반 1회용 티켓을 같이 사용한다.
- PWA 번들에는 장기 토큰을 포함하지 않는다. 일반 사용자가 보는 값은 `99999.kr` 서버 주소와 앱 도메인뿐이며, WebSocket 연결은 짧은 수명의 티켓으로만 열린다.
