import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { GlassPanel, MinecraftHead, PrimaryButton, StatusPill } from "../components/RudulgiUI";
import { theme } from "../theme";
import type { ServerMessage } from "../protocol";
import { useBridge, type ConnectionState } from "../hooks/useBridge";
import {
  getSavedAccounts,
  removeSavedAccount,
  saveAccount,
  type SavedAccount,
} from "../store/settings";

interface Props {
  bridgeUrl: string;
  mcVersion: string;
  serverAddress: string;
  onAuthenticated: (info: { ign: string; userId: string; uuid?: string }) => void;
  onChangeServer: () => void;
}

interface DeviceCode {
  code: string;
  url: string;
  expiresInSec: number;
}

// Drives the device-code login flow. We connect to the bridge, request a
// device code, surface it for the user to enter at microsoft.com/link,
// and wait for `auth_ok` before handing control to the chat screen.
export function LoginScreen({
  bridgeUrl,
  mcVersion,
  serverAddress,
  onAuthenticated,
  onChangeServer,
}: Props) {
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"connecting" | "ready" | "auth_pending" | "done">(
    "connecting",
  );
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);

  useEffect(() => {
    void getSavedAccounts().then(setAccounts);
  }, []);

  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "auth_code":
        setDeviceCode({
          code: msg.code,
          url: msg.verificationUri,
          expiresInSec: msg.expiresInSec,
        });
        setPhase("auth_pending");
        break;
      case "auth_ok":
        setPhase("done");
        void saveAccount({
          userId: msg.userId,
          ign: msg.ign,
          uuid: msg.uuid,
        }).then(setAccounts);
        onAuthenticated({ ign: msg.ign, userId: msg.userId, uuid: msg.uuid });
        break;
      case "auth_failed":
        setError(msg.reason);
        setPhase("ready");
        setDeviceCode(null);
        break;
      case "error":
        setError(msg.text);
        break;
      default:
        break;
    }
  };

  const { state, send } = useBridge(bridgeUrl, true, handleMessage);

  useEffect(() => {
    if (state === "open" && phase === "connecting") {
      setPhase("ready");
    }
  }, [state, phase]);

  const startFresh = () => {
    setError(null);
    setDeviceCode(null);
    send({ type: "auth_start", mcVersion });
  };

  const startCached = (account: SavedAccount) => {
    setError(null);
    send({ type: "auth_cached", userId: account.userId, mcVersion });
  };

  const removeAccount = (account: SavedAccount) => {
    Alert.alert(
      "계정 삭제",
      `${account.ign} 계정을 이 기기 목록에서 삭제할까요?`,
      [
        { text: "취소", style: "cancel" },
        {
          text: "삭제",
          style: "destructive",
          onPress: () => {
            void removeSavedAccount(account.userId).then(setAccounts);
          },
        },
      ],
    );
  };

  const copyCode = async () => {
    if (!deviceCode) return;
    await Clipboard.setStringAsync(deviceCode.code);
  };

  const openBrowser = async () => {
    if (!deviceCode) return;
    await WebBrowser.openBrowserAsync(deviceCode.url);
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={onChangeServer}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>계정 선택</Text>
        <ConnectionPill state={state} />
      </View>

      <Text style={styles.serverLine}>
        {serverAddress} · MC {mcVersion}
      </Text>

      {phase === "connecting" && (
        <GlassPanel style={styles.centerCard}>
          <ActivityIndicator color={theme.accent} />
          <Text style={styles.note}>연결 준비 중</Text>
        </GlassPanel>
      )}

      {phase === "ready" && (
        <View style={styles.actions}>
          {accounts.length > 0 && (
            <View style={styles.accountList}>
              {accounts.map((account) => (
                <View style={styles.accountShell} key={account.userId}>
                  <Pressable
                    onPress={() => startCached(account)}
                    style={({ pressed }) => [
                      styles.accountButton,
                      pressed ? styles.accountButtonPressed : null,
                    ]}
                  >
                    <MinecraftHead uuid={account.uuid} size={58} />
                    <View style={styles.accountCopy}>
                      <Text style={styles.accountName}>{account.ign}</Text>
                      <Text style={styles.accountSub}>
                        {formatLastUsed(account.lastUsedAt)}
                      </Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.removeButton,
                      pressed ? styles.removeButtonPressed : null,
                    ]}
                    onPress={() => removeAccount(account)}
                  >
                    <Text style={styles.removeText}>삭제</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <PrimaryButton onPress={startFresh} style={styles.microsoftButton}>
            Microsoft 계정으로 로그인
          </PrimaryButton>
        </View>
      )}

      {phase === "auth_pending" && deviceCode && (
        <GlassPanel style={styles.codeCard}>
          <Text style={styles.codeTitle}>Microsoft 로그인</Text>
          <Text style={styles.note}>브라우저에서 링크를 열고 코드를 입력하세요.</Text>
          <Pressable onPress={openBrowser}>
            <Text style={styles.link}>{deviceCode.url}</Text>
          </Pressable>
          <Pressable onPress={copyCode}>
            <Text style={styles.codeText}>{deviceCode.code}</Text>
          </Pressable>
          <PrimaryButton variant="secondary" onPress={copyCode} style={styles.copyButton}>
            코드 복사
          </PrimaryButton>
          <View style={styles.waitRow}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.waitText}>로그인 완료 대기 중</Text>
          </View>
        </GlassPanel>
      )}

      {phase === "done" && (
        <GlassPanel style={styles.centerCard}>
          <ActivityIndicator color={theme.accent} />
          <Text style={styles.note}>서버에 접속 중</Text>
        </GlassPanel>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const map: Record<ConnectionState, { label: string; tone: "online" | "warning" | "error" | "neutral" }> = {
    idle: { label: "idle", tone: "neutral" },
    connecting: { label: "connecting", tone: "warning" },
    open: { label: "online", tone: "online" },
    closed: { label: "reconnecting", tone: "warning" },
    error: { label: "error", tone: "error" },
  };
  const cfg = map[state];
  return <StatusPill label={cfg.label} tone={cfg.tone} />;
}

function formatLastUsed(timestamp: number): string {
  if (!timestamp) return "최근 접속 기록 없음";
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return "방금 접속";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}분 전 접속`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전 접속`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}일 전 접속`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} 접속`;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  content: {
    minHeight: "100%",
    paddingHorizontal: 22,
    paddingTop: 58,
    paddingBottom: 32,
    alignItems: "center",
  },
  header: {
    width: "100%",
    maxWidth: 560,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(240, 246, 252, 0.06)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  backText: {
    color: theme.text,
    fontSize: 34,
    lineHeight: 38,
  },
  headerTitle: {
    flex: 1,
    color: theme.text,
    fontSize: 20,
    fontWeight: "900",
    textAlign: "center",
    marginRight: 42,
  },
  serverLine: {
    width: "100%",
    maxWidth: 560,
    color: theme.textDim,
    fontSize: 13,
    textAlign: "center",
    marginTop: 8,
    marginBottom: 26,
  },
  centerCard: {
    width: "100%",
    maxWidth: 560,
    alignItems: "center",
    padding: 24,
  },
  note: {
    color: theme.textDim,
    marginTop: 10,
    textAlign: "center",
    lineHeight: 20,
  },
  actions: {
    width: "100%",
    maxWidth: 560,
    gap: 16,
  },
  accountList: {
    gap: 12,
  },
  accountShell: {
    flexDirection: "row",
    gap: 10,
  },
  accountButton: {
    flex: 1,
    minHeight: 96,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.glass,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 18,
  },
  accountButtonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  accountCopy: {
    flex: 1,
    marginLeft: 16,
  },
  accountName: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900",
  },
  accountSub: {
    color: theme.accent,
    fontSize: 13,
    marginTop: 5,
  },
  chevron: {
    color: theme.textDim,
    fontSize: 30,
  },
  removeButton: {
    width: 58,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(248, 81, 73, 0.08)",
    borderColor: "rgba(248, 81, 73, 0.24)",
    borderWidth: 1,
  },
  removeButtonPressed: {
    opacity: 0.75,
  },
  removeText: {
    color: theme.danger,
    fontSize: 12,
    fontWeight: "800",
  },
  microsoftButton: {
    marginTop: 10,
  },
  codeCard: {
    width: "100%",
    maxWidth: 560,
    alignItems: "center",
    padding: 22,
  },
  codeTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "900",
  },
  link: {
    color: theme.myMsg,
    textDecorationLine: "underline",
    marginTop: 16,
    fontSize: 16,
  },
  codeText: {
    color: theme.accentSoft,
    fontSize: 34,
    fontFamily: "Courier",
    fontWeight: "900",
    letterSpacing: 4,
    marginTop: 18,
    marginBottom: 16,
  },
  copyButton: {
    alignSelf: "stretch",
  },
  waitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 18,
  },
  waitText: {
    color: theme.textDim,
    fontSize: 13,
    fontWeight: "700",
  },
  error: {
    width: "100%",
    maxWidth: 560,
    color: theme.danger,
    marginTop: 24,
    textAlign: "center",
    fontWeight: "700",
  },
});
