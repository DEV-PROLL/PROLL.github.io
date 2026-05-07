import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { theme } from "../theme";
import type { ServerMessage } from "../protocol";
import { useBridge, type ConnectionState } from "../hooks/useBridge";
import {
  getCachedUserId,
  setCachedUserId,
  clearCachedUserId,
} from "../store/settings";

interface Props {
  bridgeUrl: string;
  onAuthenticated: (info: { ign: string; userId: string }) => void;
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
export function LoginScreen({ bridgeUrl, onAuthenticated, onChangeServer }: Props) {
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"connecting" | "ready" | "auth_pending" | "done">(
    "connecting",
  );
  const [cachedUserId, setCachedId] = useState<string | null>(null);

  useEffect(() => {
    void getCachedUserId().then(setCachedId);
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
        void setCachedUserId(msg.userId);
        onAuthenticated({ ign: msg.ign, userId: msg.userId });
        break;
      case "auth_failed":
        setError(msg.reason);
        setPhase("ready");
        setDeviceCode(null);
        // If a cached login failed, drop the cache so the user can re-auth.
        void clearCachedUserId();
        setCachedId(null);
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
    send({ type: "auth_start" });
  };

  const startCached = () => {
    if (!cachedUserId) return;
    setError(null);
    send({ type: "auth_cached", userId: cachedUserId });
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
    <View style={styles.root}>
      <Pressable style={styles.changeServer} onPress={onChangeServer}>
        <Text style={styles.changeServerText}>← Change bridge</Text>
      </Pressable>

      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.subtitle}>
        Bridge: <Text style={styles.mono}>{bridgeUrl}</Text>
      </Text>
      <ConnectionPill state={state} />

      {phase === "connecting" && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={styles.note}>Connecting to bridge…</Text>
        </View>
      )}

      {phase === "ready" && (
        <View style={styles.actions}>
          {cachedUserId && (
            <Pressable style={styles.button} onPress={startCached}>
              <Text style={styles.buttonText}>Continue as {cachedUserId}</Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.button, !cachedUserId && styles.primary]}
            onPress={startFresh}
          >
            <Text style={styles.buttonText}>Sign in with Microsoft</Text>
          </Pressable>
        </View>
      )}

      {phase === "auth_pending" && deviceCode && (
        <View style={styles.codeCard}>
          <Text style={styles.note}>1. Open this link on any device:</Text>
          <Pressable onPress={openBrowser}>
            <Text style={styles.link}>{deviceCode.url}</Text>
          </Pressable>
          <Text style={[styles.note, { marginTop: 16 }]}>
            2. Enter this code:
          </Text>
          <Text style={styles.codeText}>{deviceCode.code}</Text>
          <Pressable style={styles.button} onPress={copyCode}>
            <Text style={styles.buttonText}>Copy code</Text>
          </Pressable>
          <Text style={styles.note}>
            Waiting for you to finish signing in…
          </Text>
          <ActivityIndicator color={theme.accent} style={{ marginTop: 8 }} />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const map: Record<ConnectionState, { label: string; color: string }> = {
    idle: { label: "idle", color: theme.textDim },
    connecting: { label: "connecting", color: "#d29922" },
    open: { label: "connected", color: theme.accent },
    closed: { label: "reconnecting", color: "#d29922" },
    error: { label: "error", color: theme.danger },
  };
  const cfg = map[state];
  return (
    <View style={[styles.pill, { borderColor: cfg.color }]}>
      <View style={[styles.pillDot, { backgroundColor: cfg.color }]} />
      <Text style={[styles.pillText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    padding: 24,
  },
  changeServer: {
    paddingVertical: 8,
  },
  changeServerText: {
    color: theme.textDim,
  },
  title: {
    color: theme.text,
    fontSize: 28,
    fontWeight: "700",
    marginTop: 24,
  },
  subtitle: {
    color: theme.textDim,
    marginTop: 4,
  },
  mono: {
    fontFamily: "Courier",
    color: theme.text,
  },
  pill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 12,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  pillText: {
    fontSize: 12,
  },
  center: {
    marginTop: 64,
    alignItems: "center",
  },
  note: {
    color: theme.textDim,
    marginTop: 8,
    textAlign: "center",
  },
  actions: {
    marginTop: 32,
    gap: 12,
  },
  button: {
    backgroundColor: theme.cardElevated,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  primary: {
    backgroundColor: theme.accentMuted,
    borderColor: theme.accent,
  },
  buttonText: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "600",
  },
  codeCard: {
    marginTop: 32,
    padding: 20,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
  },
  link: {
    color: theme.myMsg,
    textDecorationLine: "underline",
    marginTop: 8,
    fontSize: 16,
  },
  codeText: {
    color: theme.accent,
    fontSize: 32,
    fontFamily: "Courier",
    fontWeight: "700",
    letterSpacing: 4,
    marginVertical: 12,
  },
  error: {
    color: theme.danger,
    marginTop: 24,
    textAlign: "center",
  },
});
