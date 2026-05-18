import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { theme } from "../theme";
import type {
  ChatSegment,
  CompletionMatch,
  GuiItem,
  GuiSlot,
  GuiWindow,
  PlayerSummary,
  ServerMessage,
} from "../protocol";
import { useBridge, type ConnectionState } from "../hooks/useBridge";
import { MinecraftHead, StatusPill } from "../components/RudulgiUI";

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
const MAX_INPUT_HISTORY = 50;
const MAX_AUTO_RECONNECTS = 6;

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
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [completionMatches, setCompletionMatches] = useState<CompletionMatch[]>([]);
  const [playerList, setPlayerList] = useState<PlayerSummary[]>([]);
  const [playerListOpen, setPlayerListOpen] = useState(false);
  const [serverInfo, setServerInfo] = useState<{
    server?: string;
    online?: number;
    connected: boolean;
    phase: "joining" | "online" | "offline" | "kicked";
    reason?: string;
  }>({ connected: false, phase: "joining" });
  const [activeWindow, setActiveWindow] = useState<GuiWindow | null>(null);
  const [selectedWindowSlot, setSelectedWindowSlot] = useState<number | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const [tooltipText, setTooltipText] = useState<string | null>(null);
  const listRef = useRef<FlatList<DisplayedMessage>>(null);
  const completionRequestRef = useRef("");
  const latestInputRef = useRef(input);
  const textInputRef = useRef<TextInput>(null);
  const historyDraftRef = useRef("");
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoReconnectAttemptRef = useRef(0);
  const lastAuthAttemptAtRef = useRef(0);

  useEffect(() => {
    latestInputRef.current = input;
  }, [input]);

  const scrollToBottom = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
    setTimeout(() => listRef.current?.scrollToEnd({ animated }), 80);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 260);
  }, []);

  const clearAutoReconnectTimer = useCallback(() => {
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
  }, []);

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
          if (!msg.connected) {
            setActiveWindow(null);
            setSelectedWindowSlot(null);
            setPendingSlot(null);
            setPlayerList([]);
          }
          if (msg.connected) {
            autoReconnectAttemptRef.current = 0;
            clearAutoReconnectTimer();
          }
          setServerInfo((prev) => {
            if (msg.connected) {
              return {
                server: msg.server,
                online: msg.playersOnline,
                connected: true,
                phase: "online",
                reason: undefined,
              };
            }
            return {
              server: msg.server,
              online: msg.playersOnline ?? prev.online,
              connected: false,
              phase: prev.phase === "kicked" ? "kicked" : "offline",
              reason: msg.reason ?? prev.reason,
            };
          });
          break;
        case "player_list":
          setPlayerList(msg.players);
          setServerInfo((prev) => ({
            ...prev,
            online: msg.playersOnline,
          }));
          break;
        case "completion":
          if (
            msg.requestId === completionRequestRef.current &&
            msg.text === latestInputRef.current
          ) {
            setCompletionMatches(msg.matches);
          }
          break;
        case "window_open":
          setActiveWindow(msg.window);
          setSelectedWindowSlot(null);
          setPendingSlot(null);
          break;
        case "window_update":
          setActiveWindow(msg.window);
          setSelectedWindowSlot((current) =>
            current != null && visibleGuiSlots(msg.window).some((slot) => slot.index === current)
              ? current
              : null,
          );
          setPendingSlot(null);
          break;
        case "window_close":
          setActiveWindow(null);
          setSelectedWindowSlot(null);
          setPendingSlot(null);
          break;
        case "kicked":
          clearAutoReconnectTimer();
          setServerInfo((prev) => ({
            ...prev,
            connected: false,
            phase: "kicked",
            reason: msg.reason,
          }));
          setActiveWindow(null);
          setSelectedWindowSlot(null);
          setPendingSlot(null);
          setPlayerList([]);
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
          setPendingSlot(null);
          setServerInfo((prev) =>
            prev.connected
              ? prev
              : {
                  ...prev,
                  phase: prev.phase === "kicked" ? "kicked" : "offline",
                  reason: msg.text,
                },
          );
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
          setActiveWindow(null);
          setSelectedWindowSlot(null);
          setPendingSlot(null);
          setServerInfo((prev) => ({
            ...prev,
            connected: false,
            phase: "offline",
            reason: msg.reason,
          }));
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              kind: "error",
              text: msg.reason,
              ts: Date.now(),
            },
          ]);
          if (Platform.OS === "web") {
            onLogout();
            break;
          }
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
    [clearAutoReconnectTimer, onLogout, userId],
  );

  const { state, send } = useBridge(bridgeUrl, true, handleMessage);

  const reconnect = useCallback(
    (manual = false) => {
      if (state !== "open") return false;
      const now = Date.now();
      if (!manual && now - lastAuthAttemptAtRef.current < 1200) return false;
      clearAutoReconnectTimer();
      if (manual) autoReconnectAttemptRef.current = 0;
      lastAuthAttemptAtRef.current = now;
      setActiveWindow(null);
      setSelectedWindowSlot(null);
      setPendingSlot(null);
      setServerInfo((prev) => ({
        ...prev,
        connected: false,
        phase: "joining",
        reason: manual ? undefined : prev.reason,
      }));
      const ok = send({ type: "auth_cached", userId, mcVersion });
      if (!ok) {
        setServerInfo((prev) => ({
          ...prev,
          connected: false,
          phase: "offline",
          reason: "bridge socket is not ready",
        }));
      }
      return ok;
    },
    [clearAutoReconnectTimer, mcVersion, send, state, userId],
  );

  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, completionMatches.length, scrollToBottom]);

  useEffect(() => () => clearAutoReconnectTimer(), [clearAutoReconnectTimer]);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", () => scrollToBottom(false));
    const frameSub = Keyboard.addListener("keyboardDidChangeFrame", () => scrollToBottom(false));
    return () => {
      showSub.remove();
      frameSub.remove();
    };
  }, [scrollToBottom]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const viewport = (globalThis as unknown as {
      visualViewport?: {
        addEventListener: (type: "resize" | "scroll", listener: () => void) => void;
        removeEventListener: (type: "resize" | "scroll", listener: () => void) => void;
      };
    }).visualViewport;
    if (!viewport) return;
    const handler = () => scrollToBottom(false);
    viewport.addEventListener("resize", handler);
    viewport.addEventListener("scroll", handler);
    return () => {
      viewport.removeEventListener("resize", handler);
      viewport.removeEventListener("scroll", handler);
    };
  }, [scrollToBottom]);

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

  // Re-authenticate as soon as the socket opens (covers reconnects).
  useEffect(() => {
    if (state === "open") {
      reconnect();
    }
  }, [state, reconnect]);

  useEffect(() => {
    if (state !== "open" || serverInfo.connected || serverInfo.phase === "joining") return;
    if (autoReconnectTimerRef.current) return;
    if (autoReconnectAttemptRef.current >= MAX_AUTO_RECONNECTS) return;
    const attempt = autoReconnectAttemptRef.current + 1;
    const delay = Math.min(1500 * 2 ** (attempt - 1), 15_000);
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      autoReconnectAttemptRef.current = attempt;
      reconnect(false);
    }, delay);
  }, [reconnect, serverInfo.connected, serverInfo.phase, state]);

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
    setInputHistory((prev) => {
      const withoutDuplicateTail = prev[prev.length - 1] === text ? prev.slice(0, -1) : prev;
      return [...withoutDuplicateTail, text].slice(-MAX_INPUT_HISTORY);
    });
    setHistoryCursor(null);
    historyDraftRef.current = "";
    setInput("");
    setCompletionMatches([]);
    setTimeout(() => {
      textInputRef.current?.focus();
    }, 0);
  };

  const handleInputChange = (next: string) => {
    setInput(next);
    setHistoryCursor(null);
    historyDraftRef.current = "";
  };

  const showPreviousInput = () => {
    if (inputHistory.length === 0) return;
    setHistoryCursor((current) => {
      if (current == null) {
        historyDraftRef.current = input;
        const next = inputHistory.length - 1;
        setInput(inputHistory[next]);
        return next;
      }
      const next = Math.max(0, current - 1);
      setInput(inputHistory[next]);
      return next;
    });
  };

  const showNextInput = () => {
    if (inputHistory.length === 0) return;
    setHistoryCursor((current) => {
      if (current == null) return null;
      if (current >= inputHistory.length - 1) {
        setInput(historyDraftRef.current);
        historyDraftRef.current = "";
        return null;
      }
      const next = current + 1;
      setInput(inputHistory[next]);
      return next;
    });
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
      setTooltipText(segment.hoverText);
    }
  };

  const handleWindowSlotSelect = (slot: GuiSlot) => {
    setSelectedWindowSlot(slot.index);
  };

  const handleWindowSelectedClick = () => {
    if (!activeWindow || !serverInfo.connected || selectedWindowSlot == null) return;
    const slot = activeWindow.slots.find((candidate) => candidate.index === selectedWindowSlot);
    if (!slot?.item) return;
    if (!serverInfo.connected) return;
    setPendingSlot(slot.index);
    if (!send({ type: "window_click", slot: slot.index, mouseButton: 0 })) {
      setPendingSlot(null);
      Alert.alert("Not connected", "Wait for the bridge to reconnect.");
    }
  };

  const handleWindowClose = () => {
    send({ type: "window_close" });
    setActiveWindow(null);
    setSelectedWindowSlot(null);
    setPendingSlot(null);
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

  const handlePlayerSelect = (player: PlayerSummary) => {
    const whisper = `/귓 ${player.name} `;
    setInput(whisper);
    latestInputRef.current = whisper;
    setCompletionMatches([]);
    setPlayerListOpen(false);
    setTimeout(() => textInputRef.current?.focus(), 50);
  };

  const onlineCount =
    serverInfo.online ?? (playerList.length > 0 ? playerList.length : undefined);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 40 : 0}
    >
      <View style={styles.chatShell}>
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={handleLogoutInternal}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <MinecraftHead uuid={uuid} size={46} style={styles.headerHead} />
          <View style={styles.headerCopy}>
            <Text style={styles.headerIgn} numberOfLines={1}>{ign}</Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {serverAddress} · MC {mcVersion}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <View style={styles.statusStack}>
              <ConnectionPill
                state={state}
                connected={serverInfo.connected}
                phase={serverInfo.phase}
              />
              <Pressable
                disabled={onlineCount == null}
                onPress={() => setPlayerListOpen(true)}
                style={({ pressed }) => [
                  styles.playerCountBtn,
                  pressed ? styles.playerCountBtnPressed : null,
                  onlineCount == null ? styles.playerCountBtnDisabled : null,
                ]}
              >
                <Text style={styles.playerCountText}>
                  {onlineCount != null ? `${onlineCount}명` : "-명"}
                </Text>
              </Pressable>
            </View>
            <Pressable style={styles.logoutBtn} onPress={confirmLogout}>
              <Text style={styles.logoutText}>•••</Text>
            </Pressable>
          </View>
        </View>

        {state === "open" && !serverInfo.connected && serverInfo.phase !== "joining" && (
          <View style={styles.reconnectBanner}>
            <Text style={styles.reconnectBannerText}>
              {disconnectCopy(serverInfo.phase, autoReconnectAttemptRef.current)}
            </Text>
            <Pressable style={styles.reconnectBtn} onPress={() => reconnect(true)}>
              <Text style={styles.reconnectText}>재접속</Text>
            </Pressable>
          </View>
        )}

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
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollToBottom(true)}
          onLayout={() => scrollToBottom(false)}
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
          <View style={styles.historyControls}>
            <Pressable
              style={({ pressed }) => [
                styles.historyBtn,
                pressed ? styles.historyBtnPressed : null,
                inputHistory.length === 0 ? styles.historyBtnDisabled : null,
              ]}
              disabled={inputHistory.length === 0}
              onPress={showPreviousInput}
            >
              <Text style={styles.historyText}>↑</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.historyBtn,
                pressed ? styles.historyBtnPressed : null,
                historyCursor == null ? styles.historyBtnDisabled : null,
              ]}
              disabled={historyCursor == null}
              onPress={showNextInput}
            >
              <Text style={styles.historyText}>↓</Text>
            </Pressable>
          </View>
          <TextInput
            ref={textInputRef}
            style={styles.input}
            value={input}
            onChangeText={handleInputChange}
            placeholder={serverInfo.connected ? "Message or /command" : "Reconnect to send"}
            placeholderTextColor={theme.textDim}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
            editable={serverInfo.connected}
          />
          <Pressable
            style={({ pressed }) => [
              styles.sendBtn,
              pressed ? styles.sendBtnPressed : null,
              !serverInfo.connected && styles.sendBtnDisabled,
            ]}
            onPress={serverInfo.connected ? handleSend : () => reconnect(true)}
          >
            <Text style={styles.sendText}>{serverInfo.connected ? "전송" : "재접속"}</Text>
          </Pressable>
        </View>

        {activeWindow ? (
          <GuiWindowModal
            gui={activeWindow}
            selectedSlotIndex={selectedWindowSlot}
            pendingSlot={pendingSlot}
            onClose={handleWindowClose}
            onSlotSelect={handleWindowSlotSelect}
            onClickSelected={handleWindowSelectedClick}
          />
        ) : null}

        {tooltipText ? (
          <TooltipModal text={tooltipText} onClose={() => setTooltipText(null)} />
        ) : null}

        {playerListOpen ? (
          <PlayerListModal
            players={playerList}
            onlineCount={onlineCount}
            currentIgn={ign}
            onClose={() => setPlayerListOpen(false)}
            onSelect={handlePlayerSelect}
          />
        ) : null}
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
            {...webHoverProps(segment.hoverText)}
            style={[
              segment.color ? { color: segment.color } : null,
              segment.bold ? styles.boldText : null,
              segment.italic ? styles.italicText : null,
              textDecorationFor(segment),
              clickable || hoverable ? styles.interactiveText : null,
            ]}
            onPress={
              clickable
                ? () => onSegmentClick(segment)
                : hoverable
                  ? () => onSegmentHover(segment)
                  : undefined
            }
            onLongPress={hoverable ? () => onSegmentHover(segment) : undefined}
          >
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

function webHoverProps(hoverText?: string): Record<string, unknown> {
  if (!hoverText || Platform.OS !== "web") return {};
  return { title: hoverText };
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
    label = "접속";
    tone = "online";
  } else if (state === "open" && phase === "kicked") {
    label = "킥";
    tone = "error";
  } else if (state === "open") {
    label = "입장";
    tone = "warning";
  } else if (state === "connecting" || state === "closed") {
    label = "연결";
    tone = "warning";
  }
  return <StatusPill label={label} tone={tone} style={styles.pill} />;
}

function disconnectCopy(
  phase: "joining" | "online" | "offline" | "kicked",
  attempts: number,
): string {
  const suffix =
    attempts > 0 && attempts < MAX_AUTO_RECONNECTS
      ? ` 자동 재접속 ${attempts}/${MAX_AUTO_RECONNECTS}`
      : "";
  if (attempts >= MAX_AUTO_RECONNECTS) {
    return "자동 재접속을 멈췄습니다. 직접 재접속해 주세요.";
  }
  if (phase === "kicked") return `서버에서 연결이 끊겼습니다.${suffix}`;
  return `서버 연결이 끊겼습니다.${suffix}`;
}

function GuiWindowModal({
  gui,
  selectedSlotIndex,
  pendingSlot,
  onClose,
  onSlotSelect,
  onClickSelected,
}: {
  gui: GuiWindow;
  selectedSlotIndex: number | null;
  pendingSlot: number | null;
  onClose: () => void;
  onSlotSelect: (slot: GuiSlot) => void;
  onClickSelected: () => void;
}) {
  const visibleSlots = visibleGuiSlots(gui);
  const selectedSlot =
    selectedSlotIndex == null
      ? null
      : visibleSlots.find((slot) => slot.index === selectedSlotIndex) ?? null;
  const selectedItem = selectedSlot?.item ?? null;
  const filled = visibleSlots.filter((slot) => slot.item).length;
  const canClickSelected = Boolean(selectedItem) && pendingSlot == null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.guiBackdrop}>
        <View style={styles.guiPanel}>
          <View style={styles.guiHeader}>
            <View style={styles.guiTitleWrap}>
              <Text style={styles.guiTitle} numberOfLines={1}>
                {gui.title}
              </Text>
              <Text style={styles.guiSubtitle} numberOfLines={1}>
                {gui.type} · 아이템 {filled}/{visibleSlots.length}
              </Text>
            </View>
            <Pressable style={styles.guiCloseBtn} onPress={onClose}>
              <Text style={styles.guiCloseText}>×</Text>
            </Pressable>
          </View>

          <FlatList
            key={`gui-${gui.id}`}
            data={visibleSlots}
            keyExtractor={(slot) => `${gui.id}-${slot.index}`}
            numColumns={9}
            contentContainerStyle={styles.guiGrid}
            renderItem={({ item }) => (
              <GuiSlotCell
                slot={item}
                selected={selectedSlotIndex === item.index}
                pending={pendingSlot === item.index}
                onPreview={() => onSlotSelect(item)}
              />
            )}
          />

          <View style={styles.guiDetailCard}>
            {selectedItem ? (
              <>
                <Text style={styles.guiDetailName} numberOfLines={2}>
                  {itemLabel(selectedItem)}
                </Text>
                <Text style={styles.guiDetailMeta} numberOfLines={1}>
                  슬롯 {selectedSlot?.index ?? "-"} · {selectedItem.name}
                </Text>
                {selectedItem.lore?.length ? (
                  <View style={styles.guiLoreList}>
                    {selectedItem.lore.slice(0, 8).map((line, index) => (
                      <Text
                        key={`${selectedItem.name}-${index}-${line}`}
                        style={styles.guiLoreText}
                        numberOfLines={2}
                      >
                        {line}
                      </Text>
                    ))}
                    {selectedItem.lore.length > 8 ? (
                      <Text style={styles.guiLoreMore}>
                        +{selectedItem.lore.length - 8} lines
                      </Text>
                    ) : null}
                  </View>
                ) : (
                  <Text style={styles.guiLoreEmpty}>표시할 로어 없음</Text>
                )}
              </>
            ) : (
              <Text style={styles.guiLoreEmpty}>
                {selectedSlot ? `빈 슬롯 ${selectedSlot.index}` : "슬롯을 선택하면 이름과 로어가 표시됩니다"}
              </Text>
            )}
          </View>

          <View style={styles.guiFooter}>
            <View style={styles.guiSelectionCopy}>
              <Text style={styles.guiFooterText} numberOfLines={1}>
                {selectedItem
                  ? itemLabel(selectedItem)
                  : selectedSlot
                    ? `빈 슬롯 ${selectedSlot.index}`
                    : "슬롯을 선택하세요"}
              </Text>
              {gui.selectedItem ? (
                <Text style={styles.guiCursorText} numberOfLines={1}>
                  커서: {itemLabel(gui.selectedItem)}
                </Text>
              ) : null}
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.guiActionBtn,
                pressed && canClickSelected ? styles.guiActionBtnPressed : null,
                !canClickSelected ? styles.guiActionBtnDisabled : null,
              ]}
              disabled={!canClickSelected}
              onPress={onClickSelected}
            >
              <Text style={styles.guiActionText}>
                {pendingSlot == null ? "클릭 실행" : "처리 중"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function TooltipModal({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.tooltipBackdrop} onPress={onClose}>
        <Pressable style={styles.tooltipPanel}>
          <Text style={styles.tooltipTitle}>상세 정보</Text>
          <Text style={styles.tooltipText}>{text}</Text>
          <Pressable style={styles.tooltipCloseBtn} onPress={onClose}>
            <Text style={styles.tooltipCloseText}>닫기</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PlayerListModal({
  players,
  onlineCount,
  currentIgn,
  onClose,
  onSelect,
}: {
  players: PlayerSummary[];
  onlineCount?: number;
  currentIgn: string;
  onClose: () => void;
  onSelect: (player: PlayerSummary) => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.playerListBackdrop} onPress={onClose}>
        <Pressable style={styles.playerListPanel}>
          <View style={styles.playerListHeader}>
            <View>
              <Text style={styles.playerListTitle}>온라인 플레이어</Text>
              <Text style={styles.playerListSubtitle}>
                {onlineCount != null ? `${onlineCount}명 접속 중` : "목록 수신 대기 중"}
              </Text>
            </View>
            <Pressable style={styles.playerListCloseBtn} onPress={onClose}>
              <Text style={styles.playerListCloseText}>×</Text>
            </Pressable>
          </View>

          {players.length > 0 ? (
            <FlatList
              data={players}
              keyExtractor={(player) => player.uuid || player.name}
              style={styles.playerRows}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [
                    styles.playerRow,
                    item.name === currentIgn ? styles.playerRowSelf : null,
                    pressed ? styles.playerRowPressed : null,
                  ]}
                  onPress={() => onSelect(item)}
                >
                  <MinecraftHead uuid={item.uuid} size={34} style={styles.playerRowHead} />
                  <View style={styles.playerRowCopy}>
                    <Text style={styles.playerRowName} numberOfLines={1}>
                      {item.name}
                      {item.name === currentIgn ? " · 나" : ""}
                    </Text>
                    <Text style={styles.playerRowMeta} numberOfLines={1}>
                      {item.displayName || "탭하면 귓속말 입력"}
                    </Text>
                  </View>
                  {item.ping != null ? (
                    <Text style={styles.playerPing}>{Math.round(item.ping)}ms</Text>
                  ) : null}
                </Pressable>
              )}
            />
          ) : (
            <Text style={styles.playerListEmpty}>
              서버가 플레이어 목록을 아직 보내지 않았습니다.
            </Text>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function GuiSlotCell({
  slot,
  selected,
  pending,
  onPreview,
}: {
  slot: GuiSlot;
  selected: boolean;
  pending: boolean;
  onPreview: () => void;
}) {
  const item = slot.item;
  const label = item ? shortItemLabel(item) : "";
  const detail = item ? itemDetail(item) : `Empty slot ${slot.index}`;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.guiSlot,
        item ? { borderColor: itemColor(item.name) } : null,
        selected ? styles.guiSlotSelected : null,
        pressed ? styles.guiSlotPressed : null,
        pending ? styles.guiSlotPending : null,
      ]}
      onPress={onPreview}
      onHoverIn={onPreview}
      onLongPress={() => Alert.alert(`Slot ${slot.index}`, detail)}
    >
      {item ? (
        <>
          <View style={[styles.guiItemIcon, { backgroundColor: itemColor(item.name) }]}>
            <Text style={styles.guiItemIconText} numberOfLines={1}>
              {label}
            </Text>
          </View>
          {item.count > 1 ? (
            <Text style={styles.guiItemCount}>{item.count}</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.guiEmptySlotText}>{slot.index}</Text>
      )}
    </Pressable>
  );
}

function visibleGuiSlots(gui: GuiWindow): GuiSlot[] {
  const containerSlotCount =
    Number.isFinite(gui.inventoryStart) && gui.inventoryStart > 0
      ? gui.inventoryStart
      : gui.slots.length;
  const visibleSlots = gui.slots.filter((slot) => slot.index < containerSlotCount);
  return visibleSlots.length > 0 ? visibleSlots : gui.slots;
}

function itemLabel(item: GuiItem): string {
  return `${item.displayName || item.name}${item.count > 1 ? ` x${item.count}` : ""}`;
}

function itemDetail(item: GuiItem): string {
  const lines = [itemLabel(item), ...(item.lore ?? [])];
  return lines.join("\n");
}

function shortItemLabel(item: GuiItem): string {
  const cleaned = (item.name || item.displayName)
    .replace(/^minecraft:/, "")
    .replace(/_/g, " ")
    .trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

function itemColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const colors = [
    "#3fb950",
    "#58a6ff",
    "#d29922",
    "#a371f7",
    "#f778ba",
    "#56d4dd",
    "#f85149",
  ];
  return colors[hash % colors.length];
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: "center",
  },
  chatShell: {
    flex: 1,
    width: "100%",
    maxWidth: 780,
    backgroundColor: theme.bg,
    borderLeftColor: theme.glassBorder,
    borderLeftWidth: 1,
    borderRightColor: theme.glassBorder,
    borderRightWidth: 1,
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
  headerCopy: {
    flex: 1,
    minWidth: 0,
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
    marginHorizontal: 0,
  },
  headerActions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: 10,
  },
  statusStack: {
    alignItems: "center",
    gap: 5,
  },
  playerCountBtn: {
    minWidth: 58,
    minHeight: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    paddingHorizontal: 8,
    backgroundColor: "rgba(240, 246, 252, 0.05)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  playerCountBtnPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.96 }],
  },
  playerCountBtnDisabled: {
    opacity: 0.5,
  },
  playerCountText: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "900",
  },
  logoutBtn: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: "rgba(240, 246, 252, 0.06)",
  },
  logoutText: {
    color: theme.textDim,
    fontSize: 14,
    fontWeight: "900",
  },
  reconnectBanner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: "rgba(210, 153, 34, 0.12)",
    borderBottomColor: "rgba(210, 153, 34, 0.26)",
    borderBottomWidth: 1,
    gap: 10,
  },
  reconnectBannerText: {
    flex: 1,
    color: theme.text,
    fontSize: 13,
    fontWeight: "700",
  },
  reconnectBtn: {
    borderColor: theme.accent,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "rgba(126, 231, 135, 0.12)",
  },
  reconnectText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "800",
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
    fontWeight: "900",
  },
  italicText: {
    fontStyle: "italic",
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
  interactiveText: {
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
  historyControls: {
    width: 34,
    gap: 6,
  },
  historyBtn: {
    flex: 1,
    minHeight: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme.inputGlass,
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  historyBtnPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.96 }],
  },
  historyBtnDisabled: {
    opacity: 0.35,
  },
  historyText: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "900",
    lineHeight: 16,
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
  guiBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.58)",
    paddingHorizontal: 12,
    paddingBottom: Platform.OS === "ios" ? 22 : 12,
  },
  guiPanel: {
    width: "100%",
    maxWidth: 760,
    maxHeight: "82%",
    backgroundColor: "rgba(13, 17, 23, 0.96)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 24,
    overflow: "hidden",
  },
  guiHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  guiTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  guiTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900",
  },
  guiSubtitle: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 3,
  },
  guiCloseBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(240, 246, 252, 0.06)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  guiCloseText: {
    color: theme.text,
    fontSize: 24,
    lineHeight: 27,
    fontWeight: "800",
  },
  guiGrid: {
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  guiSlot: {
    width: 36,
    height: 36,
    margin: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(22, 27, 34, 0.86)",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  guiSlotPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.94 }],
  },
  guiSlotSelected: {
    borderColor: theme.accent,
    borderWidth: 2,
    backgroundColor: "rgba(126, 231, 135, 0.1)",
  },
  guiSlotPending: {
    borderColor: theme.accentSoft,
    backgroundColor: "rgba(126, 231, 135, 0.15)",
  },
  guiItemIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  guiItemIconText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "900",
  },
  guiItemCount: {
    position: "absolute",
    right: 3,
    bottom: 1,
    color: theme.text,
    fontSize: 10,
    fontWeight: "900",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 2,
  },
  guiEmptySlotText: {
    color: "rgba(139, 148, 158, 0.35)",
    fontSize: 9,
    fontWeight: "700",
  },
  guiDetailCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    backgroundColor: "rgba(13, 17, 23, 0.76)",
    minHeight: 64,
  },
  guiDetailName: {
    color: theme.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "900",
  },
  guiDetailMeta: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: 3,
  },
  guiFooter: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopColor: theme.glassBorder,
    borderTopWidth: 1,
    backgroundColor: "rgba(22, 27, 34, 0.78)",
  },
  guiSelectionCopy: {
    flex: 1,
    minWidth: 0,
  },
  guiFooterText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "800",
  },
  guiCursorText: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: 3,
  },
  guiLoreList: {
    marginTop: 7,
    gap: 3,
  },
  guiLoreText: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 16,
  },
  guiLoreMore: {
    color: theme.accent,
    fontSize: 11,
    fontWeight: "800",
    marginTop: 2,
  },
  guiLoreEmpty: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  guiActionBtn: {
    minWidth: 96,
    minHeight: 40,
    alignSelf: "center",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    backgroundColor: theme.accentMuted,
    borderColor: "rgba(126, 231, 135, 0.46)",
    borderWidth: 1,
  },
  guiActionBtnPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  guiActionBtnDisabled: {
    opacity: 0.45,
    backgroundColor: "rgba(139, 148, 158, 0.14)",
    borderColor: theme.glassBorder,
  },
  guiActionText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "900",
  },
  tooltipBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.28)",
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === "ios" ? 26 : 14,
  },
  tooltipPanel: {
    width: "100%",
    maxWidth: 620,
    alignSelf: "center",
    backgroundColor: "rgba(13, 17, 23, 0.98)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 10,
  },
  tooltipTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900",
  },
  tooltipText: {
    color: theme.text,
    fontSize: 14,
    lineHeight: 20,
  },
  tooltipCloseBtn: {
    alignSelf: "flex-end",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "rgba(240, 246, 252, 0.06)",
  },
  tooltipCloseText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "800",
  },
  playerListBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === "ios" ? 26 : 14,
  },
  playerListPanel: {
    width: "100%",
    maxWidth: 620,
    maxHeight: "72%",
    backgroundColor: "rgba(13, 17, 23, 0.98)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 22,
    overflow: "hidden",
  },
  playerListHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  playerListTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900",
  },
  playerListSubtitle: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 3,
  },
  playerListCloseBtn: {
    width: 38,
    height: 38,
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: "rgba(240, 246, 252, 0.06)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  playerListCloseText: {
    color: theme.text,
    fontSize: 24,
    lineHeight: 27,
    fontWeight: "800",
  },
  playerRows: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  playerRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 9,
    gap: 10,
  },
  playerRowSelf: {
    backgroundColor: "rgba(126, 231, 135, 0.08)",
  },
  playerRowPressed: {
    backgroundColor: "rgba(240, 246, 252, 0.08)",
    transform: [{ scale: 0.99 }],
  },
  playerRowHead: {
    flexShrink: 0,
  },
  playerRowCopy: {
    flex: 1,
    minWidth: 0,
  },
  playerRowName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900",
  },
  playerRowMeta: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 2,
  },
  playerPing: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "800",
  },
  playerListEmpty: {
    color: theme.textDim,
    fontSize: 14,
    lineHeight: 20,
    padding: 18,
  },
});
