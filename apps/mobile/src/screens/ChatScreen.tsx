import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { theme } from "../theme";
import type { ChatSegment, CompletionMatch, ServerMessage } from "../protocol";
import { useBridge, type ConnectionState } from "../hooks/useBridge";
import { MinecraftHead, StatusPill } from "../components/RudulgiUI";
import { removeSavedAccount } from "../store/settings";

interface Props {
  bridgeUrl: string;
  mcVersion: string;
  serverAddress: string;
  ign: string;
  userId: string;
  uuid?: string;
  onLogout: () => void;
}

interface DisplayedMessage {
  id: string;
  kind: "chat" | "system" | "error";
  from?: string | null;
  fromUuid?: string;
  text: string;
  segments?: ChatSegment[];
  ts: number;
}

let messageCounter = 0;
const newId = () => `m-${++messageCounter}-${Date.now()}`;

export function ChatScreen({
  bridgeUrl,
  mcVersion,
  serverAddress,
  ign,
  userId,
  uuid,
  onLogout,
}: Props) {
  const [messages, setMessages] = useState<DisplayedMessage[]>([]);
  const [input, setInput] = useState("");
  const [completionMatches, setCompletionMatches] = useState<CompletionMatch[]>([]);
  const [serverInfo, setServerInfo] = useState<{
    server?: string;
    online?: number;
    connected: boolean;
    phase: "joining" | "online" | "offline" | "kicked";
  }>({ connected: false, phase: "joining" });
  const listRef = useRef<FlatList<DisplayedMessage>>(null);
  const completionRequestRef = useRef("");
  const inputRef = useRef(input);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

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
              fromUuid: msg.fromUuid,
              text: msg.text,
              segments: msg.segments,
              ts: msg.ts,
            },
          ]);
          break;
        case "system":
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              kind: "system",
              text: msg.text,
              segments: msg.segments,
              ts: msg.ts,
            },
          ]);
          break;
        case "status":
          setServerInfo({
            server: msg.server,
            online: msg.playersOnline,
            connected: msg.connected,
            phase: msg.connected ? "online" : "offline",
          });
          break;
        case "completion":
          if (
            msg.requestId === completionRequestRef.current &&
            msg.text === inputRef.current
          ) {
            setCompletionMatches(msg.matches);
          }
          break;
        case "kicked":
          setServerInfo((prev) => ({
            ...prev,
            connected: false,
            phase: "kicked",
          }));
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
          void removeSavedAccount(userId);
          Alert.alert("다시 로그인 필요", msg.reason, [
            {
              text: "OK",
              onPress: () => {
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

  useEffect(() => {
    const query = input.trimStart();
    if (state !== "open" || !serverInfo.connected || !query.startsWith("/")) {
      setCompletionMatches([]);
      completionRequestRef.current = "";
      return;
    }

    const timer = setTimeout(() => {
      const requestId = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      completionRequestRef.current = requestId;
      send({ type: "complete", requestId, text: input });
    }, 220);

    return () => {
      clearTimeout(timer);
    };
  }, [input, send, serverInfo.connected, state]);

  const reconnect = () => {
    setServerInfo((prev) => ({
      ...prev,
      connected: false,
      phase: "joining",
    }));
    send({ type: "auth_cached", userId, mcVersion });
  };

  // Re-authenticate as soon as the socket opens (covers reconnects).
  useEffect(() => {
    if (state === "open") {
      reconnect();
    }
  }, [state, send, userId, mcVersion]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    if (!serverInfo.connected) {
      Alert.alert("Not in server", "Reconnect before sending chat or commands.");
      return;
    }
    if (!send({ type: "send", text })) {
      Alert.alert("Not connected", "Wait for the bridge to reconnect.");
      return;
    }
    setInput("");
    setCompletionMatches([]);
  };

  const handleCompletionPress = (match: CompletionMatch) => {
    setInput((current) => applyCompletion(current, match.value));
    setCompletionMatches([]);
  };

  const handleSegmentClick = (segment: ChatSegment) => {
    const event = segment.clickEvent;
    if (!event) return;
    switch (event.action) {
      case "run_command":
        Alert.alert("Run command?", event.value, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Run",
            onPress: () => {
              if (!serverInfo.connected) return;
              send({ type: "send", text: event.value });
            },
          },
        ]);
        break;
      case "suggest_command":
        setInput(event.value);
        break;
      case "open_url":
        Alert.alert("Open link?", event.value, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Open",
            onPress: () => {
              void Linking.openURL(event.value);
            },
          },
        ]);
        break;
      case "copy_to_clipboard":
        void Clipboard.setStringAsync(event.value);
        break;
      default:
        Alert.alert(event.action, event.value);
        break;
    }
  };

  const handleSegmentHover = (segment: ChatSegment) => {
    if (segment.hoverText) {
      Alert.alert("Details", segment.hoverText);
    }
  };

  const handleLogoutInternal = () => {
    send({ type: "logout" });
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
        <Pressable style={styles.backBtn} onPress={onLogout}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <MinecraftHead uuid={uuid} size={46} style={styles.headerHead} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerIgn}>{ign}</Text>
          <Text style={styles.headerSub}>
            {serverAddress} · MC {mcVersion}
            {serverInfo.online != null ? `  ·  ${serverInfo.online} online` : ""}
          </Text>
        </View>
        <ConnectionPill
          state={state}
          connected={serverInfo.connected}
          phase={serverInfo.phase}
        />
        {state === "open" && !serverInfo.connected && (
          <Pressable style={styles.reconnectBtn} onPress={reconnect}>
            <Text style={styles.reconnectText}>Reconnect</Text>
          </Pressable>
        )}
        <Pressable style={styles.logoutBtn} onPress={confirmLogout}>
          <Text style={styles.logoutText}>•••</Text>
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Row
            message={item}
            myIgn={ign}
            onSegmentClick={handleSegmentClick}
            onSegmentHover={handleSegmentHover}
          />
        )}
        contentContainerStyle={styles.list}
        onContentSizeChange={() =>
          listRef.current?.scrollToEnd({ animated: true })
        }
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {completionMatches.length > 0 && (
        <View style={styles.completionBar}>
          <FlatList
            horizontal
            data={completionMatches}
            keyExtractor={(item) => item.value}
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <Pressable
                style={styles.completionChip}
                onPress={() => handleCompletionPress(item)}
                onLongPress={() => {
                  if (item.tooltip) Alert.alert(item.value, item.tooltip);
                }}
              >
                <Text style={styles.completionText} numberOfLines={1}>
                  {item.value}
                </Text>
              </Pressable>
            )}
          />
        </View>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={serverInfo.connected ? "Message or /command" : "Reconnect to send"}
          placeholderTextColor={theme.textDim}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="send"
          onSubmitEditing={handleSend}
          editable={serverInfo.connected}
        />
        <Pressable
          style={({ pressed }) => [
            styles.sendBtn,
            pressed && serverInfo.connected ? styles.sendBtnPressed : null,
            !serverInfo.connected && styles.sendBtnDisabled,
          ]}
          onPress={handleSend}
        >
          <Text style={styles.sendText}>전송</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Row({
  message,
  myIgn,
  onSegmentClick,
  onSegmentHover,
}: {
  message: DisplayedMessage;
  myIgn: string;
  onSegmentClick: (segment: ChatSegment) => void;
  onSegmentHover: (segment: ChatSegment) => void;
}) {
  if (message.kind === "system") {
    return (
      <RichText
        text={message.text}
        segments={message.segments}
        style={styles.systemRow}
        onSegmentClick={onSegmentClick}
        onSegmentHover={onSegmentHover}
      />
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
      {message.fromUuid ? (
        <MinecraftHead uuid={message.fromUuid} size={22} style={styles.chatHead} />
      ) : null}
      <Text
        style={[
          styles.chatFrom,
          { color: mine ? theme.myMsg : theme.accent },
        ]}
      >
        {message.from ?? "server"}
      </Text>
      <RichText
        text={message.text}
        segments={message.segments}
        style={styles.chatText}
        onSegmentClick={onSegmentClick}
        onSegmentHover={onSegmentHover}
      />
    </View>
  );
}

function RichText({
  text,
  segments,
  style,
  onSegmentClick,
  onSegmentHover,
}: {
  text: string;
  segments?: ChatSegment[];
  style: object;
  onSegmentClick: (segment: ChatSegment) => void;
  onSegmentHover: (segment: ChatSegment) => void;
}) {
  if (!segments?.length) {
    return <Text style={style}>{text}</Text>;
  }
  return (
    <Text style={style}>
      {segments.map((segment, index) => {
        const clickable = Boolean(segment.clickEvent);
        const hoverable = Boolean(segment.hoverText);
        return (
          <Text
            key={`${index}-${segment.text}`}
            style={[
              segment.color ? { color: segment.color } : null,
              segment.bold ? styles.boldText : styles.normalWeightText,
              segment.italic ? styles.italicText : styles.normalText,
              textDecorationFor(segment),
              clickable ? styles.clickableText : null,
            ]}
            onPress={clickable ? () => onSegmentClick(segment) : undefined}
            onLongPress={hoverable ? () => onSegmentHover(segment) : undefined}
          >
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

function textDecorationFor(segment: ChatSegment) {
  if (segment.underlined && segment.strikethrough) {
    return styles.underlineStrikeText;
  }
  if (segment.underlined) return styles.underlineText;
  if (segment.strikethrough) return styles.strikeText;
  return null;
}

function applyCompletion(current: string, value: string): string {
  const tokenStart = Math.max(current.lastIndexOf(" "), current.lastIndexOf("\n")) + 1;
  const prefix = current.slice(0, tokenStart);
  let replacement = value;

  if (prefix.length === 0 && current.trimStart().startsWith("/") && !replacement.startsWith("/")) {
    replacement = `/${replacement}`;
  }

  const next = `${prefix}${replacement}`;
  return next.endsWith(" ") ? next : `${next} `;
}

function ConnectionPill({
  state,
  connected,
  phase,
}: {
  state: ConnectionState;
  connected: boolean;
  phase: "joining" | "online" | "offline" | "kicked";
}) {
  let label: string = "offline";
  let tone: "online" | "warning" | "error" | "neutral" = "error";
  if (state === "open" && connected) {
    label = "online";
    tone = "online";
  } else if (state === "open" && phase === "kicked") {
    label = "kicked";
    tone = "error";
  } else if (state === "open") {
    label = "joining";
    tone = "warning";
  } else if (state === "connecting" || state === "closed") {
    label = "connecting";
    tone = "warning";
  }
  return <StatusPill label={label} tone={tone} style={styles.pill} />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 56,
    paddingBottom: 14,
    backgroundColor: "rgba(13, 17, 23, 0.94)",
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    backgroundColor: "rgba(240, 246, 252, 0.06)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  backText: {
    color: theme.text,
    fontSize: 32,
    lineHeight: 36,
  },
  headerHead: {
    marginRight: 12,
  },
  headerIgn: {
    color: theme.text,
    fontSize: 19,
    fontWeight: "900",
  },
  headerSub: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 3,
  },
  pill: {
    marginHorizontal: 8,
  },
  logoutBtn: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: "rgba(240, 246, 252, 0.06)",
  },
  reconnectBtn: {
    borderColor: theme.accent,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginRight: 6,
  },
  reconnectText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "700",
  },
  logoutText: {
    color: theme.textDim,
    fontSize: 14,
    fontWeight: "900",
  },
  list: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
    flexGrow: 1,
  },
  systemRow: {
    color: theme.systemMsg,
    fontSize: 15,
    lineHeight: 21,
    marginVertical: 3,
  },
  errorRow: {
    backgroundColor: "rgba(248, 81, 73, 0.12)",
    borderColor: theme.danger,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
    marginVertical: 6,
  },
  errorRowText: {
    color: theme.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  chatRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginVertical: 4,
  },
  chatHead: {
    marginRight: 7,
  },
  chatFrom: {
    fontWeight: "900",
    marginRight: 6,
    fontSize: 15,
  },
  chatText: {
    color: theme.text,
    flexShrink: 1,
    fontSize: 15,
    lineHeight: 21,
  },
  completionBar: {
    borderTopColor: theme.glassBorder,
    borderTopWidth: 1,
    backgroundColor: "rgba(13, 17, 23, 0.94)",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  completionChip: {
    maxWidth: 180,
    backgroundColor: theme.glass,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginRight: 8,
  },
  completionText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700",
  },
  boldText: {
    fontWeight: "800",
  },
  normalWeightText: {
    fontWeight: "400",
  },
  italicText: {
    fontStyle: "italic",
  },
  normalText: {
    fontStyle: "normal",
  },
  underlineText: {
    textDecorationLine: "underline",
  },
  strikeText: {
    textDecorationLine: "line-through",
  },
  underlineStrikeText: {
    textDecorationLine: "underline line-through",
  },
  clickableText: {
    opacity: 0.95,
  },
  composer: {
    flexDirection: "row",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 18,
    backgroundColor: "rgba(13, 17, 23, 0.96)",
    borderTopColor: theme.glassBorder,
    borderTopWidth: 1,
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 54,
    backgroundColor: theme.inputGlass,
    color: theme.text,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 17,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  sendBtn: {
    minWidth: 76,
    backgroundColor: theme.accentMuted,
    borderColor: "rgba(126, 231, 135, 0.45)",
    borderWidth: 1,
    paddingHorizontal: 16,
    borderRadius: 17,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  sendBtnDisabled: {
    backgroundColor: theme.cardElevated,
    borderColor: theme.glassBorder,
  },
  sendText: {
    color: theme.text,
    fontWeight: "900",
    fontSize: 16,
  },
});
