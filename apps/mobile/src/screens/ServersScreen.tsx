import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_SERVER_ADDRESS,
  DEFAULT_SERVER_ID,
  DEFAULT_SERVER_LABEL,
  normalizeServerId,
} from "../appConfig";
import {
  DEFAULT_MC_VERSION,
  isSupportedMcVersion,
  normalizeMcVersion,
} from "../mcVersions";
import {
  getBridgeUrl,
  getMcVersion,
  getSavedAccounts,
  getServerAddress,
  getServerId,
  setBridgeUrl,
  setMcVersion,
  setServerAddress,
  setServerId,
  type SavedAccount,
} from "../store/settings";
import { GlassPanel, MinecraftHead, PrimaryButton, StatusPill } from "../components/RudulgiUI";
import { theme } from "../theme";

interface Props {
  onContinue: (
    bridgeUrl: string,
    serverId: string,
    mcVersion: string,
    serverAddress: string,
  ) => void;
}

interface ServerStatus {
  online: number | null;
  max: number | null;
  version: string | null;
  ok: boolean;
  loading: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt: () => Promise<void>;
}

export function ServersScreen({ onContinue }: Props) {
  const [serverAddress, setLocalServerAddress] = useState(DEFAULT_SERVER_ADDRESS);
  const [serverId, setLocalServerId] = useState(DEFAULT_SERVER_ID);
  const [bridgeUrl, setLocalBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [mcVersion, setLocalMcVersion] = useState(DEFAULT_MC_VERSION);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [standaloneMode, setStandaloneMode] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus>({
    online: null,
    max: null,
    version: null,
    ok: false,
    loading: true,
  });

  useEffect(() => {
    void Promise.all([
      getBridgeUrl(),
      getServerId(),
      getMcVersion(),
      getServerAddress(),
      getSavedAccounts(),
    ]).then(([storedBridgeUrl, storedServerId, version, address, savedAccounts]) => {
      setLocalServerId(normalizeServerId(storedServerId));
      if (address) setLocalServerAddress(address);
      const effectiveBridgeUrl = resolveInitialBridgeUrl(storedBridgeUrl);
      if (effectiveBridgeUrl) {
        setLocalBridgeUrl(effectiveBridgeUrl);
        if (effectiveBridgeUrl !== storedBridgeUrl) {
          void setBridgeUrl(effectiveBridgeUrl);
        }
      }
      if (version) setLocalMcVersion(version);
      setAccounts(savedAccounts);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    setStandaloneMode(isStandalonePwa());
    setInstallDismissed(readInstallDismissed());

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => {
      setStandaloneMode(true);
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const next = await fetchServerStatus(bridgeUrl, serverId);
      if (!cancelled) setServerStatus(next);
    };

    void poll();
    timer = setInterval(() => {
      void poll();
    }, 5_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [bridgeUrl, serverId]);

  const handleConnect = async () => {
    setFormError(null);
    setSubmitting(true);
    const address = normalizeServerAddress(serverAddress);
    if (!address) {
      setFormError("서버 주소를 입력해 주세요.");
      setSubmitting(false);
      return;
    }

    const trimmedBridgeUrl = bridgeUrl.trim();
    if (!/^wss?:\/\//.test(trimmedBridgeUrl)) {
      setFormError("앱 연결 설정이 아직 준비되지 않았습니다.");
      setSubmitting(false);
      return;
    }

    const normalizedServerId = normalizeServerId(serverId);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedServerId)) {
      setFormError("서버 ID 설정이 올바르지 않습니다.");
      setSubmitting(false);
      return;
    }

    const normalized = normalizeMcVersion(mcVersion);
    if (!normalized || !isSupportedMcVersion(mcVersion)) {
      setFormError("현재 루둘기는 Minecraft 1.21.11 접속 기준입니다.");
      setSubmitting(false);
      return;
    }

    await setServerAddress(address);
    await setServerId(normalizedServerId);
    await setBridgeUrl(trimmedBridgeUrl);
    await setMcVersion(normalized);
    onContinue(trimmedBridgeUrl, normalizedServerId, normalized, address);
    setSubmitting(false);
  };

  const handleInstallPress = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    setInstallPrompt(null);
  };

  const dismissInstallHint = () => {
    setInstallDismissed(true);
    writeInstallDismissed();
  };

  const primaryAccount = accounts[0];
  const installHint = getInstallHint({
    canPrompt: Boolean(installPrompt),
    dismissed: installDismissed,
    standalone: standaloneMode,
  });

  if (loading) {
    return (
      <View style={[styles.root, styles.loadingRoot]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <MinecraftHead size={78} />
        <Text style={styles.kicker}>{DEFAULT_SERVER_LABEL} 전용 채팅</Text>
        <Pressable
          onLongPress={() => setAdvancedOpen((value) => !value)}
          delayLongPress={900}
        >
          <Text style={styles.title}>{DEFAULT_SERVER_LABEL}</Text>
        </Pressable>
        <Text style={styles.serverTitle}>{DEFAULT_SERVER_ADDRESS}</Text>
        <Text style={styles.subtitle}>Minecraft Java 채팅 · 명령어</Text>
      </View>

      <GlassPanel style={styles.card}>
        <View style={styles.metaRow}>
          <StatusPill
            label={formatOnlineStatus(serverStatus)}
            tone={serverStatus.ok ? "online" : serverStatus.loading ? "warning" : "error"}
          />
          <StatusPill label={serverStatus.version ?? `MC ${DEFAULT_MC_VERSION}`} />
        </View>

        <View style={styles.divider} />

        <View style={styles.accountPreview}>
          <MinecraftHead uuid={primaryAccount?.uuid} size={56} />
          <View style={styles.accountCopy}>
            <Text style={styles.accountName}>
              {primaryAccount?.ign ?? "Microsoft 계정"}
            </Text>
            <Text style={styles.accountSub}>
              {primaryAccount ? "최근 접속" : "로그인 후 본인 계정으로 접속"}
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </View>

        <PrimaryButton
          onPress={handleConnect}
          loading={submitting}
          style={styles.connectButton}
        >
          접속하기
        </PrimaryButton>

        {formError && <Text style={styles.formError}>{formError}</Text>}

        {advancedOpen && (
          <View style={styles.advancedBox}>
            <Text style={styles.advancedTitle}>개발자 설정</Text>
            <Text style={styles.label}>Server</Text>
            <TextInput
              value={serverAddress}
              onChangeText={setLocalServerAddress}
              placeholder={DEFAULT_SERVER_ADDRESS}
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <Text style={styles.label}>Server ID</Text>
            <TextInput
              value={serverId}
              onChangeText={setLocalServerId}
              placeholder={DEFAULT_SERVER_ID}
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <Text style={styles.label}>Bridge</Text>
            <TextInput
              value={bridgeUrl}
              onChangeText={setLocalBridgeUrl}
              placeholder="wss://bridge.example.com"
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <Text style={styles.label}>Version</Text>
            <TextInput
              value={mcVersion}
              onChangeText={setLocalMcVersion}
              placeholder={DEFAULT_MC_VERSION}
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={styles.input}
            />
          </View>
        )}
      </GlassPanel>

      <Text style={styles.help}>
        Microsoft 계정으로 로그인하면 서버 채팅과 명령어를 사용할 수 있습니다.
      </Text>

      {installHint ? (
        <GlassPanel style={styles.installCard}>
          <View style={styles.installCopy}>
            <Text style={styles.installTitle}>홈 화면 앱</Text>
            <Text style={styles.installText}>{installHint.text}</Text>
          </View>
          <View style={styles.installActions}>
            {installPrompt ? (
              <PrimaryButton
                variant="secondary"
                onPress={handleInstallPress}
                style={styles.installButton}
                textStyle={styles.installButtonText}
              >
                앱 설치
              </PrimaryButton>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={dismissInstallHint}
              style={({ pressed }) => [
                styles.installDismiss,
                pressed ? styles.installDismissPressed : null,
              ]}
            >
              <Text style={styles.installDismissText}>닫기</Text>
            </Pressable>
          </View>
        </GlassPanel>
      ) : null}
    </ScrollView>
  );
}

function normalizeServerAddress(address: string): string {
  return address
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^wss?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:25565$/, "");
}

function resolveInitialBridgeUrl(storedBridgeUrl: string | null): string {
  // The production PWA ships with the operator-managed bridge URL. Prefer it
  // over any old localStorage value left from Expo, localhost, or Tailscale
  // testing so normal users always land on the public app path.
  if (!__DEV__ && DEFAULT_BRIDGE_URL) return DEFAULT_BRIDGE_URL;
  return storedBridgeUrl || DEFAULT_BRIDGE_URL;
}

async function fetchServerStatus(
  bridgeUrl: string,
  serverId: string,
): Promise<ServerStatus> {
  try {
    const url = toStatusUrl(bridgeUrl, serverId);
    const response = await fetch(url, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const body = (await response.json()) as {
      ok?: boolean;
      playersOnline?: unknown;
      playersMax?: unknown;
      version?: unknown;
    };
    if (!body.ok) throw new Error("server status unavailable");
    return {
      online: typeof body.playersOnline === "number" ? body.playersOnline : null,
      max: typeof body.playersMax === "number" ? body.playersMax : null,
      version: typeof body.version === "string" ? body.version : null,
      ok: true,
      loading: false,
    };
  } catch {
    return {
      online: null,
      max: null,
      version: null,
      ok: false,
      loading: false,
    };
  }
}

function toStatusUrl(bridgeUrl: string, serverId: string): string {
  const url = new URL(bridgeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/status";
  if (serverId) {
    url.searchParams.set("serverId", serverId);
  }
  return url.toString();
}

function formatOnlineStatus(status: ServerStatus): string {
  if (status.loading) return "상태 확인 중";
  if (!status.ok || status.online == null) return "상태 확인 불가";
  if (status.max != null) return `온라인 ${status.online}/${status.max}명`;
  return `온라인 ${status.online}명`;
}

function isStandalonePwa(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  const navigatorStandalone =
    "standalone" in window.navigator
      ? Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
      : false;
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.matchMedia?.("(display-mode: fullscreen)")?.matches ||
    navigatorStandalone
  );
}

function getInstallHint({
  canPrompt,
  dismissed,
  standalone,
}: {
  canPrompt: boolean;
  dismissed: boolean;
  standalone: boolean;
}): { text: string } | null {
  if (Platform.OS !== "web" || dismissed || standalone) return null;

  if (isIosLike()) {
    return {
      text: "Safari 공유 버튼에서 홈 화면에 추가하면 주소창 없이 열립니다.",
    };
  }
  if (canPrompt) {
    return {
      text: "설치하면 주소창 없이 바로 열 수 있습니다.",
    };
  }
  return {
    text: "브라우저 메뉴에서 홈 화면에 추가할 수 있습니다.",
  };
}

function isIosLike(): boolean {
  if (Platform.OS !== "web" || typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(platform) ||
    (/Mac/.test(platform) && typeof document !== "undefined" && "ontouchend" in document) ||
    /iPad|iPhone|iPod/.test(ua)
  );
}

function readInstallDismissed(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem("rudulgi-install-dismissed") === "1";
  } catch {
    return false;
  }
}

function writeInstallDismissed() {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    window.localStorage?.setItem("rudulgi-install-dismissed", "1");
  } catch {
    // Ignore private browsing or blocked storage.
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  loadingRoot: {
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    minHeight: "100%",
    paddingHorizontal: 24,
    paddingVertical: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  hero: {
    width: "100%",
    maxWidth: 520,
    alignItems: "center",
    marginBottom: 26,
  },
  kicker: {
    color: theme.accentSoft,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 18,
    marginBottom: 8,
  },
  title: {
    color: theme.text,
    fontSize: 34,
    fontWeight: "900",
    textAlign: "center",
  },
  serverTitle: {
    color: theme.text,
    fontSize: 38,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 4,
  },
  subtitle: {
    color: theme.textDim,
    textAlign: "center",
    marginTop: 10,
  },
  card: {
    width: "100%",
    maxWidth: 520,
    padding: 20,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  divider: {
    height: 1,
    backgroundColor: theme.glassBorder,
    marginVertical: 18,
  },
  accountPreview: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 70,
  },
  accountCopy: {
    flex: 1,
    marginLeft: 14,
  },
  accountName: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900",
  },
  accountSub: {
    color: theme.textDim,
    fontSize: 13,
    marginTop: 4,
  },
  chevron: {
    color: theme.textDim,
    fontSize: 30,
  },
  connectButton: {
    marginTop: 18,
  },
  formError: {
    color: theme.danger,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 12,
    textAlign: "center",
  },
  advancedBox: {
    marginTop: 18,
    borderTopColor: theme.glassBorder,
    borderTopWidth: 1,
    paddingTop: 18,
  },
  advancedTitle: {
    color: theme.text,
    fontWeight: "800",
    marginBottom: 12,
  },
  label: {
    color: theme.textDim,
    fontSize: 12,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: theme.inputGlass,
    color: theme.text,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 13,
    fontSize: 16,
    marginBottom: 12,
  },
  help: {
    width: "100%",
    maxWidth: 520,
    color: theme.textDim,
    fontSize: 12,
    marginTop: 24,
    textAlign: "center",
    lineHeight: 18,
  },
  installCard: {
    width: "100%",
    maxWidth: 520,
    marginTop: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  installCopy: {
    flex: 1,
  },
  installTitle: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 4,
  },
  installText: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  installActions: {
    alignItems: "flex-end",
    gap: 8,
  },
  installButton: {
    minHeight: 40,
    borderRadius: 13,
    paddingHorizontal: 14,
  },
  installButtonText: {
    fontSize: 13,
  },
  installDismiss: {
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  installDismissPressed: {
    opacity: 0.65,
  },
  installDismissText: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "800",
  },
});
