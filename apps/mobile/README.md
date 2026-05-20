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

`apps/mobile/dist`는 GitHub Pages나 정적 호스팅에 올릴 수 있다. iPhone/iPad에서는 Safari로 접속 후 공유 메뉴의 **홈 화면에 추가**를 사용한다. HTTPS 페이지에서는 브릿지 URL도 `wss://`여야 한다.

운영 빌드에서는 브릿지 주소를 빌드 시 주입한다:

```bash
EXPO_PUBLIC_BRIDGE_URL="wss://bridge.proit.kr?token=<BRIDGE_TOKEN>" npm run web:export
```

그러면 일반 사용자는 첫 화면에서 `99999.kr`만 확인하고 로그인 흐름으로 넘어간다.
내부 프로토콜은 `serverId`를 같이 보내므로, 운영자가 브릿지 `SERVER_PROFILES`와
앱 UI를 확장하면 나중에 다른 서버도 같은 구조로 붙일 수 있다.

## 빌드

```bash
# EAS 설치 후
npx eas build -p ios       # IPA (애플 개발자 계정 필요)
npx eas build -p android   # APK/AAB
```

## 보안 주의

- `expo-secure-store`로 브릿지 URL과 `userId`(IGN), 표시용 UUID만 저장. **MS 토큰은 앱에 없음** (브릿지에 보관).
- PWA에 들어가는 query token은 추출 가능하므로 장기 운영에서는 사용자별 short-lived token 발급 방식을 추가하는 것이 좋다.
