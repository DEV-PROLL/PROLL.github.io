import { useEffect, useState } from "react";
import {
  ActivityIndicator,
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
  DEFAULT_SERVER_LABEL,
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
  setBridgeUrl,
  setMcVersion,
  setServerAddress,
  type SavedAccount,
} from "../store/settings";
import { GlassPanel, MinecraftHead, PrimaryButton, StatusPill } from "../components/RudulgiUI";
import { theme } from "../theme";

interface Props {
  onContinue: (
    bridgeUrl: string,
    mcVersion: string,
    serverAddress: string,
  ) => void;
}

export function ServersScreen({ onContinue }: Props) {
  const [serverAddress, setLocalServerAddress] = useState(DEFAULT_SERVER_ADDRESS);
  const [bridgeUrl, setLocalBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [mcVersion, setLocalMcVersion] = useState(DEFAULT_MC_VERSION);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void Promise.all([
      getBridgeUrl(),
      getMcVersion(),
      getServerAddress(),
      getSavedAccounts(),
    ]).then(([storedBridgeUrl, version, address, savedAccounts]) => {
      if (address) setLocalServerAddress(address);
      if (storedBridgeUrl) setLocalBridgeUrl(storedBridgeUrl);
      if (version) setLocalMcVersion(version);
      setAccounts(savedAccounts);
      setLoading(false);
    });
  }, []);

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

    const normalized = normalizeMcVersion(mcVersion);
    if (!normalized || !isSupportedMcVersion(mcVersion)) {
      setFormError("현재 루둘기는 Minecraft 1.21.11 접속 기준입니다.");
      setSubmitting(false);
      return;
    }

    await setServerAddress(address);
    await setBridgeUrl(trimmedBridgeUrl);
    await setMcVersion(normalized);
    onContinue(trimmedBridgeUrl, normalized, address);
    setSubmitting(false);
  };

  const primaryAccount = accounts[0];

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
          <StatusPill label="온라인 69명" tone="online" />
          <StatusPill label="MC 1.21.11" />
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
    justifyContent: "center",
  },
  hero: {
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
    color: theme.textDim,
    fontSize: 12,
    marginTop: 24,
    textAlign: "center",
    lineHeight: 18,
  },
});
