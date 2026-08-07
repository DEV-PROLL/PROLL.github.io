# mobile — PROLL Minecraft 채팅 앱

Expo 기반 React Native 앱. 브릿지에 WSS로 붙어 본인 Microsoft 계정으로 마크 서버에 join 한 상태로 채팅/명령어를 주고받는다.

## 화면 흐름

```
ServersScreen   →   LoginScreen   →   ChatScreen
(99999.kr 전용 진입) → (디바이스 코드 → MS 인증) → (실시간 채팅)
```

## 개발 실행

```bash
# 레포 루트에서
npm install
npm run mobile:start
# Expo Go 앱으로 QR 스캔, 또는 i/a 눌러 시뮬레이터
```

브릿지를 같이 띄워야 함:
```bash
npm run bridge:dev
# 브릿지 URL: ws://<로컬 머신 IP>:8080
```

> 같은 Wi-Fi에 폰이 있어야 로컬 브릿지에 붙는다. 운영은 맥미니 Cloudflare Tunnel의 `wss://bridge.proit.kr`를 사용한다.

## 웹/PWA

```bash
npm run web:export
python3 -m http.server 19006 --directory apps/mobile/dist
```

`apps/mobile/dist`는 GitHub Pages나 정적 호스팅에 올릴 수 있다. iPhone/iPad에서는 Safari로 접속 후 공유 메뉴의 **홈 화면에 추가**를 사용한다. Android에서는 Chrome으로 접속 후 **앱 설치** 또는 **홈 화면에 추가**를 사용한다. HTTPS 페이지에서는 브릿지 URL도 `wss://`여야 한다.

운영 빌드에서는 브릿지 호스트만 빌드 시 주입한다:

```bash
EXPO_PUBLIC_BRIDGE_URL="wss://bridge.proit.kr" npm run web:export
```

그러면 일반 사용자는 첫 화면에서 `99999.kr`만 확인하고 로그인 흐름으로 넘어간다.
내부 프로토콜은 `serverId`를 같이 보내므로, 운영자가 브릿지 `SERVER_PROFILES`와
앱 UI를 확장하면 나중에 다른 서버도 같은 구조로 붙일 수 있다.

GUI 아이템 텍스처 미러를 바꾸려면 `/data/<버전>/items`와 `/blocks`의 상위 경로를
`EXPO_PUBLIC_MINECRAFT_ASSETS_BASE_URL`로 지정한다. 기본값은
`https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master`다.

PWA는 WebSocket을 열기 전에 `https://bridge.proit.kr/client-ticket`에서 짧은 수명의 1회용 티켓을 받아 `wss://bridge.proit.kr?ticket=...`로 접속한다. 그래서 웹 번들 안에 장기 `BRIDGE_TOKEN`을 넣지 않는다.

`npm run web:export` 후 준비 스크립트는 GitHub Pages 호환을 위해 `.nojekyll`을 만들고, Expo JS 번들을 루트 `app.js?v=<bundle-hash>`로 복사한다. 배포 직후 오래된 화면이 계속 보이면 Safari/Chrome 새로고침, 홈 화면 앱 재추가, 또는 브라우저 사이트 데이터 삭제를 확인한다.

## 빌드

```bash
# EAS 설치 후
npx eas build -p ios       # IPA (애플 개발자 계정 필요)
npx eas build -p android   # APK/AAB
```

## 보안 주의

- `expo-secure-store`로 브릿지 URL과 `userId`(IGN), 표시용 UUID만 저장. **MS 토큰은 앱에 없음** (브릿지에 보관).
- PWA에는 장기 query token을 넣지 않는다. 운영 브릿지는 허용 Origin에서만 `/client-ticket`을 발급하고, WebSocket은 이 티켓 또는 운영자용 `BRIDGE_TOKEN`이 있어야 열린다.
