import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
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
  clearPendingLoginRequestId,
  getSavedAccounts,
  getPendingLoginRequestId,
  removeSavedAccount,
  saveAccount,
  setPendingLoginRequestId,
  type SavedAccount,
} from "../store/settings";

interface Props {
  bridgeUrl: string;
  serverId: string;
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
  serverId,
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
  const [accountToRemove, setAccountToRemove] = useState<SavedAccount | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [pendingLoginRequestId, setPendingLoginRequestIdState] = useState<string | null>(null);
  const [authHint, setAuthHint] = useState<string | null>(null);
  const openAuthRequestRef = useRef<string | null>(null);

  useEffect(() => {
    void getSavedAccounts().then(setAccounts);
    void getPendingLoginRequestId().then((requestId) => {
      if (!requestId) return;
      setPendingLoginRequestIdState(requestId);
      setPhase("auth_pending");
    });
  }, []);

  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "auth_code":
        setAuthHint(null);
        setDeviceCode({
          code: msg.code,
          url: msg.verificationUri,
          expiresInSec: msg.expiresInSec,
        });
        setPhase("auth_pending");
        break;
      case "auth_ok":
        setAuthHint(null);
        setPhase("done");
        setPendingLoginRequestIdState(null);
        void clearPendingLoginRequestId();
        void saveAccount({
          userId: msg.userId,
          ign: msg.ign,
          uuid: msg.uuid,
        }).then(setAccounts);
        onAuthenticated({ ign: msg.ign, userId: msg.userId, uuid: msg.uuid });
        break;
      case "auth_failed":
        setAuthHint(null);
        setError(msg.reason);
        setPhase("ready");
        setDeviceCode(null);
        setPendingLoginRequestIdState(null);
        void clearPendingLoginRequestId();
        break;
      case "error":
        setError(msg.text);
        break;
      default:
        break;
    }
  };

  const { state, send } = useBridge(bridgeUrl, true, handleMessage);

  const sendAuthStart = useCallback(
    (requestId: string): boolean => {
      const sent = send({ type: "auth_start", serverId, mcVersion, loginRequestId: requestId });
      if (sent) openAuthRequestRef.current = requestId;
      return sent;
    },
    [mcVersion, send, serverId],
  );

  useEffect(() => {
    if (state === "open" && phase === "connecting") {
      setPhase("ready");
    }
  }, [state, phase]);

  useEffect(() => {
    if (state !== "open") {
      openAuthRequestRef.current = null;
      return;
    }
    if (!pendingLoginRequestId || phase === "done") return;
    if (openAuthRequestRef.current === pendingLoginRequestId) return;
    sendAuthStart(pendingLoginRequestId);
  }, [pendingLoginRequestId, phase, sendAuthStart, state]);

  const startFresh = () => {
    if (state !== "open") {
      setError("브릿지 서버와 연결 중입니다. 잠시 후 다시 시도하세요.");
      return;
    }
    const requestId = createLoginRequestId();
    setError(null);
    setAuthHint(null);
    setDeviceCode(null);
    setPendingLoginRequestIdState(requestId);
    setPhase("auth_pending");
    void setPendingLoginRequestId(requestId);
    sendAuthStart(requestId);
  };

  const startCached = (account: SavedAccount) => {
    if (state !== "open") {
      setError("브릿지 서버와 연결 중입니다. 잠시 후 다시 시도하세요.");
      return;
    }
    setError(null);
    setAuthHint(null);
    setPendingLoginRequestIdState(null);
    void clearPendingLoginRequestId();
    send({ type: "auth_cached", userId: account.userId, serverId, mcVersion });
  };

  const forgetAccount = async (account: SavedAccount) => {
    setRemovePending(true);
    try {
      send({ type: "forget_account", userId: account.userId });
      const next = await removeSavedAccount(account.userId);
      setAccounts(next);
      setAccountToRemove(null);
    } finally {
      setRemovePending(false);
    }
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
            void forgetAccount(account);
          },
        },
      ],
    );
  };

  const requestRemoveAccount = (account: SavedAccount) => {
    if (Platform.OS === "web") {
      setAccountToRemove(account);
      return;
    }
    removeAccount(account);
  };

  const copyCode = async () => {
    if (!deviceCode) return;
    await Clipboard.setStringAsync(deviceCode.code);
    setAuthHint("인증 코드가 복사되었습니다.");
  };

  const openBrowser = async () => {
    if (!deviceCode) return;
    await copyCode();
    if (Platform.OS === "web") {
      const browserWindow = (
        globalThis as typeof globalThis & {
          window?: { open?: (url?: string, target?: string, features?: string) => unknown };
        }
      ).window;
      browserWindow?.open?.(deviceCode.url, "_blank", "noopener,noreferrer");
      setAuthHint("인증 후 루둘기 앱 탭으로 돌아와 주세요.");
      return;
    }
    await WebBrowser.openBrowserAsync(deviceCode.url);
    setAuthHint("인증 후 루둘기 앱으로 돌아오면 자동으로 이어받습니다.");
  };

  const resumePendingLogin = () => {
    if (!pendingLoginRequestId) {
      setAuthHint("로그인 요청이 없습니다. 다시 로그인을 시작해 주세요.");
      return;
    }
    setError(null);
    openAuthRequestRef.current = null;
    const sent = sendAuthStart(pendingLoginRequestId);
    setAuthHint(
      sent
        ? "로그인 완료 여부를 다시 확인 중입니다."
        : "브릿지 연결이 열리면 자동으로 이어받습니다.",
    );
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
                    onPress={() => requestRemoveAccount(account)}
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

      {phase === "auth_pending" && !deviceCode && (
        <GlassPanel style={styles.centerCard}>
          <ActivityIndicator color={theme.accent} />
          <Text style={styles.note}>
            Microsoft 인증 코드를 요청 중입니다. 화면이 멈춘 것 같으면 다시 확인을 눌러주세요.
          </Text>
          <PrimaryButton
            variant="secondary"
            onPress={resumePendingLogin}
            style={styles.pendingResumeButton}
          >
            다시 확인
          </PrimaryButton>
          {authHint ? <Text style={styles.authHint}>{authHint}</Text> : null}
        </GlassPanel>
      )}

      {phase === "auth_pending" && deviceCode && (
        <GlassPanel style={styles.codeCard}>
          <Text style={styles.codeTitle}>Microsoft 로그인</Text>
          <Text style={styles.note}>
            브라우저에서 링크를 열고 코드를 입력한 뒤 루둘기 앱으로 돌아오세요.
          </Text>
          <Pressable onPress={openBrowser}>
            <Text style={styles.link}>{deviceCode.url}</Text>
          </Pressable>
          <Pressable onPress={copyCode}>
            <Text style={styles.codeText}>{deviceCode.code}</Text>
          </Pressable>
          <View style={styles.authActionRow}>
            <PrimaryButton onPress={openBrowser} style={styles.authActionButton}>
              인증 페이지 열기
            </PrimaryButton>
            <PrimaryButton
              variant="secondary"
              onPress={copyCode}
              style={styles.authActionButton}
            >
              코드 복사
            </PrimaryButton>
          </View>
          <PrimaryButton
            variant="secondary"
            onPress={resumePendingLogin}
            style={styles.resumeButton}
          >
            완료 확인
          </PrimaryButton>
          {authHint ? <Text style={styles.authHint}>{authHint}</Text> : null}
          <View style={styles.waitRow}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.waitText}>로그인 완료 대기 중 · 재연결되어도 이어받습니다</Text>
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

      <DeleteAccountModal
        account={accountToRemove}
        pending={removePending}
        onCancel={() => {
          if (!removePending) setAccountToRemove(null);
        }}
        onConfirm={(account) => {
          void forgetAccount(account);
        }}
      />
    </ScrollView>
  );
}

function DeleteAccountModal({
  account,
  pending,
  onCancel,
  onConfirm,
}: {
  account: SavedAccount | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (account: SavedAccount) => void;
}) {
  return (
    <Modal visible={!!account} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <GlassPanel style={styles.modalCard}>
          <MinecraftHead uuid={account?.uuid} size={54} />
          <Text style={styles.modalTitle}>계정 삭제</Text>
          <Text style={styles.modalBody}>
            {account?.ign ?? "이 계정"}을 이 기기 목록에서 삭제할까요?
          </Text>
          <View style={styles.modalActions}>
            <PrimaryButton
              variant="secondary"
              disabled={pending}
              onPress={onCancel}
              style={styles.modalButton}
            >
              취소
            </PrimaryButton>
            <PrimaryButton
              loading={pending}
              onPress={() => {
                if (account) onConfirm(account);
              }}
              style={[styles.modalButton, styles.deleteConfirmButton]}
            >
              삭제
            </PrimaryButton>
          </View>
        </GlassPanel>
      </View>
    </Modal>
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

function createLoginRequestId(): string {
  const randomSource = globalThis.crypto;
  if (typeof randomSource?.randomUUID === "function") {
    return randomSource.randomUUID();
  }
  return `login-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
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
  authActionRow: {
    alignSelf: "stretch",
    flexDirection: "row",
    gap: 10,
  },
  authActionButton: {
    flex: 1,
    minHeight: 52,
  },
  resumeButton: {
    alignSelf: "stretch",
    minHeight: 50,
    marginTop: 10,
  },
  pendingResumeButton: {
    alignSelf: "stretch",
    minHeight: 50,
    marginTop: 18,
  },
  authHint: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 12,
    textAlign: "center",
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
  modalOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(1, 4, 9, 0.72)",
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    padding: 22,
  },
  modalTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "900",
    marginTop: 14,
  },
  modalBody: {
    color: theme.textDim,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginTop: 8,
  },
  modalActions: {
    width: "100%",
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },
  modalButton: {
    flex: 1,
    minHeight: 50,
  },
  deleteConfirmButton: {
    backgroundColor: "rgba(248, 81, 73, 0.72)",
    borderColor: "rgba(248, 81, 73, 0.52)",
  },
});
