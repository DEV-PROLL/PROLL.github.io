import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "../theme";
import type { ServerMessage } from "../protocol";
import { useBridge, type ConnectionState } from "../hooks/useBridge";
import { clearCachedUserId } from "../store/settings";

interface Props {
  bridgeUrl: string;
  ign: string;
  userId: string;
  onLogout: () => void;
}

interface DisplayedMessage {
  id: string;
  kind: "chat" | "system" | "error";
  from?: string | null;
  text: string;
  ts: number;
}

let messageCounter = 0;
const newId = () => `m-${++messageCounter}-${Date.now()}`;

export function ChatScreen({ bridgeUrl, ign, userId, onLogout }: Props) {
  const [messages, setMessages] = useState<DisplayedMessage[]>([]);
  const [input, setInput] = useState("");
  const [serverInfo, setServerInfo] = useState<{
    server?: string;
    online?: number;
    connected: boolean;
  }>({ connected: false });
  const listRef = useRef<FlatList<DisplayedMessage>>(null);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "chat":
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              kind: "chat",
              from: msg.from,
              text: msg.text,
              ts: msg.ts,
            },
          ]);
          break;
        case "system":
          setMessages((prev) => [
            ...prev,
            { id: newId(), kind: "system", text: msg.text, ts: msg.ts },
          ]);
          break;
        case "status":
          setServerInfo({
            server: msg.server,
            online: msg.playersOnline,
            connected: msg.connected,
          });
          break;
        case "kicked":
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              kind: "error",
              text: `Kicked: ${msg.reason}`,
              ts: Date.now(),
            },
          ]);
          break;
        case "error":
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              kind: "error",
              text: msg.text,
              ts: Date.now(),
            },
          ]);
          break;
        case "auth_failed":
          Alert.alert("Auth failed", msg.reason, [
            {
              text: "OK",
              onPress: () => {
                void clearCachedUserId();
                onLogout();
              },
            },
          ]);
          break;
        default:
          break;
      }
    },
    [onLogout],
  );

  const { state, send } = useBridge(bridgeUrl, true, handleMessage);

  // Re-authenticate as soon as the socket opens (covers reconnects).
  useEffect(() => {
    if (state === "open") {
      send({ type: "auth_cached", userId });
    }
  }, [state, send, userId]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    if (!send({ type: "send", text })) {
      Alert.alert("Not connected", "Wait for the bridge to reconnect.");
      return;
    }
    setInput("");
  };

  const handleLogoutInternal = () => {
    send({ type: "logout" });
    void clearCachedUserId();
    onLogout();
  };

  const confirmLogout = () => {
    Alert.alert("Sign out?", `Disconnect ${ign} from the server.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: handleLogoutInternal },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 40 : 0}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerIgn}>{ign}</Text>
          <Text style={styles.headerSub}>
            {serverInfo.server ?? bridgeUrl}
            {serverInfo.online != null ? `  ·  ${serverInfo.online} online` : ""}
          </Text>
        </View>
        <ConnectionPill state={state} connected={serverInfo.connected} />
        <Pressable style={styles.logoutBtn} onPress={confirmLogout}>
          <Text style={styles.logoutText}>Sign out</Text>
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <Row message={item} myIgn={ign} />}
        contentContainerStyle={styles.list}
        onContentSizeChange={() =>
          listRef.current?.scrollToEnd({ animated: true })
        }
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message or /command"
          placeholderTextColor={theme.textDim}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="send"
          onSubmitEditing={handleSend}
        />
        <Pressable style={styles.sendBtn} onPress={handleSend}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Row({ message, myIgn }: { message: DisplayedMessage; myIgn: string }) {
  if (message.kind === "system") {
    return (
      <Text style={styles.systemRow}>{message.text}</Text>
    );
  }
  if (message.kind === "error") {
    return (
      <View style={styles.errorRow}>
        <Text style={styles.errorRowText}>{message.text}</Text>
      </View>
    );
  }
  const mine = message.from === myIgn;
  return (
    <View style={styles.chatRow}>
      <Text
        style={[
          styles.chatFrom,
          { color: mine ? theme.myMsg : theme.accent },
        ]}
      >
        {message.from ?? "server"}
      </Text>
      <Text style={styles.chatText}>{message.text}</Text>
    </View>
  );
}

function ConnectionPill({
  state,
  connected,
}: {
  state: ConnectionState;
  connected: boolean;
}) {
  let color: string = theme.danger;
  let label: string = "offline";
  if (state === "open" && connected) {
    color = theme.accent;
    label = "online";
  } else if (state === "open") {
    color = "#d29922";
    label = "joining";
  } else if (state === "connecting" || state === "closed") {
    color = "#d29922";
    label = "connecting";
  }
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    backgroundColor: theme.card,
    borderBottomColor: theme.border,
    borderBottomWidth: 1,
  },
  headerIgn: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700",
  },
  headerSub: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: 2,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 12,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  pillText: {
    fontSize: 11,
  },
  logoutBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  logoutText: {
    color: theme.textDim,
    fontSize: 12,
  },
  list: {
    padding: 16,
    flexGrow: 1,
  },
  systemRow: {
    color: theme.systemMsg,
    fontStyle: "italic",
    fontSize: 13,
    marginVertical: 2,
  },
  errorRow: {
    backgroundColor: "#3b1a1a",
    borderColor: theme.danger,
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
    marginVertical: 4,
  },
  errorRowText: {
    color: theme.danger,
    fontSize: 13,
  },
  chatRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginVertical: 3,
  },
  chatFrom: {
    fontWeight: "700",
    marginRight: 6,
  },
  chatText: {
    color: theme.text,
    flexShrink: 1,
  },
  composer: {
    flexDirection: "row",
    padding: 12,
    backgroundColor: theme.card,
    borderTopColor: theme.border,
    borderTopWidth: 1,
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: theme.inputBg,
    color: theme.text,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: theme.accentMuted,
    paddingHorizontal: 16,
    borderRadius: 8,
    justifyContent: "center",
  },
  sendText: {
    color: theme.text,
    fontWeight: "700",
  },
});
