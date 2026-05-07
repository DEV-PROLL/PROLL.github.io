# mobile — PROLL Minecraft 채팅 앱

Expo 기반 React Native 앱. 브릿지에 WSS로 붙어 본인 Microsoft 계정으로 마크 서버에 join 한 상태로 채팅/명령어를 주고받는다.

## 화면 흐름

```
ServersScreen   →   LoginScreen   →   ChatScreen
(브릿지 URL 저장) → (디바이스 코드 → MS 인증) → (실시간 채팅)
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

> 같은 Wi-Fi에 폰이 있어야 로컬 브릿지에 붙는다. 외부에서 쓰려면 브릿지를 Fly.io에 배포 후 `wss://...` 사용.

## 빌드

```bash
# EAS 설치 후
npx eas build -p ios       # IPA (애플 개발자 계정 필요)
npx eas build -p android   # APK/AAB
```

## 보안 주의

- `expo-secure-store`로 브릿지 URL과 `userId`(IGN)만 저장. **MS 토큰은 앱에 없음** (브릿지에 보관).
- 따라서 폰을 분실해도 마크 계정 자체가 노출되진 않음. 단 브릿지 URL이 노출되면 그 URL을 아는 사람은 사용자의 캐시된 봇 세션을 재연결할 수 있으므로 URL은 추측 어렵게 둘 것 (또는 ALLOWED_ORIGINS 등으로 보호).
