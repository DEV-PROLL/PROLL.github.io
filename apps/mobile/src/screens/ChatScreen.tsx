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
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeSyntheticEvent, TextInputKeyPressEventData, ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { theme } from "../theme";
import type {
  BossBarSummary,
  ChatSegment,
  CompletionMatch,
  GuiItem,
  GuiSlot,
  GuiWindow,
  PlayerPosition,
  PlayerSummary,
  ServerMessage,
} from "../protocol";
import { useBridge, type ConnectionState } from "../hooks/useBridge";
import { MinecraftHead, StatusPill } from "../components/RudulgiUI";
import { MinecraftItemIcon } from "../components/MinecraftItemIcon";
import { MovementPanel } from "../components/MovementPanel";
import {
  MAP_ENABLED,
  MOVEMENT_PANEL_ENABLED,
  MOVEMENT_TEST_IGN,
} from "../appConfig";
import {
  EMPTY_MAP_VIEW,
  applyMapMessage,
  type MapViewState,
} from "../mapFrame";

interface Props {
  bridgeUrl: string;
  serverId: string;
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

interface ActionBarState {
  text: string;
  segments?: ChatSegment[];
  ts: number;
}

interface PlayerVitals {
  health?: number;
  food?: number;
  saturation?: number;
  level?: number;
  xpProgress?: number;
}

interface TitleLineState {
  text: string;
  segments?: ChatSegment[];
}

interface TitleOverlayState {
  title?: TitleLineState;
  subtitle?: TitleLineState;
  ts: number;
}

interface TitleTimingState {
  fadeIn: number;
  stay: number;
  fadeOut: number;
}

interface PublicServerStatus {
  ok: boolean;
  online?: number;
  stale?: boolean;
}

let messageCounter = 0;
const newId = () => `m-${++messageCounter}-${Date.now()}`;
const MAX_INPUT_HISTORY = 50;
const MAX_AUTO_RECONNECTS = 6;
const BACKGROUND_SESSION_LABEL = "잠시 닫아도 유지";
const DEFAULT_TITLE_TIMING: TitleTimingState = { fadeIn: 10, stay: 70, fadeOut: 20 };
const WEB_GLASS_BLUR =
  Platform.OS === "web"
    ? ({
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      } as unknown as ViewStyle)
    : null;

export function ChatScreen({
  bridgeUrl,
  serverId,
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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [appInfoOpen, setAppInfoOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [position, setPosition] = useState<PlayerPosition | null>(null);
  const [mapView, setMapView] = useState<MapViewState>(EMPTY_MAP_VIEW);
  const [bossBars, setBossBars] = useState<BossBarSummary[]>([]);
  const [playerVitals, setPlayerVitals] = useState<PlayerVitals | null>(null);
  const [actionBar, setActionBar] = useState<ActionBarState | null>(null);
  const [titleOverlay, setTitleOverlay] = useState<TitleOverlayState | null>(null);
  const [publicStatus, setPublicStatus] = useState<PublicServerStatus>({ ok: false });
  const [serverInfo, setServerInfo] = useState<{
    server?: string;
    online?: number;
    connected: boolean;
    phase: "joining" | "online" | "offline" | "kicked";
    reason?: string;
  }>({ connected: false, phase: "joining" });
  const [activeWindow, setActiveWindow] = useState<GuiWindow | null>(null);
  const [selectedWindowSlot, setSelectedWindowSlot] = useState<number | null>(null);
  const [previewWindowSlot, setPreviewWindowSlot] = useState<number | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const [tooltipText, setTooltipText] = useState<string | null>(null);
  const listRef = useRef<FlatList<DisplayedMessage>>(null);
  const completionRequestRef = useRef("");
  const latestInputRef = useRef(input);
  const textInputRef = useRef<TextInput>(null);
  const historyDraftRef = useRef("");
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleTimingRef = useRef<TitleTimingState>(DEFAULT_TITLE_TIMING);
  const autoReconnectAttemptRef = useRef(0);
  const lastAuthAttemptAtRef = useRef(0);
  const movementOpenRef = useRef(false);

  const resetMovementPanel = useCallback(() => {
    movementOpenRef.current = false;
    setMovementOpen(false);
    setPosition(null);
    setMapView(EMPTY_MAP_VIEW);
  }, []);

  useEffect(() => {
    latestInputRef.current = input;
  }, [input]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const next = await fetchPublicServerStatus(bridgeUrl, serverId);
      if (!cancelled) setPublicStatus(next);
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

  const clearOverlayTimers = useCallback(() => {
    if (actionBarTimerRef.current) {
      clearTimeout(actionBarTimerRef.current);
      actionBarTimerRef.current = null;
    }
    if (titleTimerRef.current) {
      clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
  }, []);

  const clearTransientOverlays = useCallback(() => {
    clearOverlayTimers();
    setActionBar(null);
    setTitleOverlay(null);
    titleTimingRef.current = DEFAULT_TITLE_TIMING;
  }, [clearOverlayTimers]);

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
            setPreviewWindowSlot(null);
            setPendingSlot(null);
            setPlayerList([]);
            setBossBars([]);
            setPlayerVitals(null);
            resetMovementPanel();
            clearTransientOverlays();
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
        case "boss_bars":
          setBossBars(msg.bars);
          break;
        case "player_state":
          setPlayerVitals({
            health: msg.health,
            food: msg.food,
            saturation: msg.saturation,
            level: msg.level,
            xpProgress: msg.xpProgress,
          });
          break;
        case "position":
          if (!movementOpenRef.current) break;
          setPosition({
            x: msg.x,
            y: msg.y,
            z: msg.z,
            yaw: msg.yaw,
            direction: msg.direction,
            dimension: msg.dimension,
            grounded: msg.grounded,
            ts: msg.ts,
          });
          break;
        case "map_frame":
        case "map_state":
          if (!movementOpenRef.current) break;
          setMapView((current) => applyMapMessage(current, msg));
          break;
        case "action_bar":
          setActionBar({ text: msg.text, segments: msg.segments, ts: msg.ts });
          if (actionBarTimerRef.current) clearTimeout(actionBarTimerRef.current);
          actionBarTimerRef.current = setTimeout(() => {
            setActionBar(null);
            actionBarTimerRef.current = null;
          }, 3500);
          break;
        case "title":
          if (msg.event === "times") {
            titleTimingRef.current = {
              fadeIn: msg.fadeIn,
              stay: msg.stay,
              fadeOut: msg.fadeOut,
            };
            break;
          }
          if (msg.event === "clear") {
            if (titleTimerRef.current) {
              clearTimeout(titleTimerRef.current);
              titleTimerRef.current = null;
            }
            setTitleOverlay(null);
            break;
          }
          setTitleOverlay((prev) => ({
            ...prev,
            [msg.part]: { text: msg.text, segments: msg.segments },
            ts: msg.ts,
          }));
          if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
          titleTimerRef.current = setTimeout(() => {
            setTitleOverlay(null);
            titleTimerRef.current = null;
          }, titleStayMs(titleTimingRef.current));
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
          textInputRef.current?.blur();
          Keyboard.dismiss();
          setActiveWindow(msg.window);
          setSelectedWindowSlot(null);
          setPreviewWindowSlot(null);
          setPendingSlot(null);
          break;
        case "window_update":
          setActiveWindow(msg.window);
          setSelectedWindowSlot((current) => validGuiSlotIndex(msg.window, current));
          setPreviewWindowSlot((current) => validGuiSlotIndex(msg.window, current));
          setPendingSlot(null);
          break;
        case "window_close":
          setActiveWindow(null);
          setSelectedWindowSlot(null);
          setPreviewWindowSlot(null);
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
          setPreviewWindowSlot(null);
          setPendingSlot(null);
          setPlayerList([]);
          setBossBars([]);
          setPlayerVitals(null);
          resetMovementPanel();
          clearTransientOverlays();
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
          setPreviewWindowSlot(null);
          setPendingSlot(null);
          resetMovementPanel();
          clearTransientOverlays();
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
    [
      clearAutoReconnectTimer,
      clearTransientOverlays,
      onLogout,
      resetMovementPanel,
      userId,
    ],
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
      setPreviewWindowSlot(null);
      setPendingSlot(null);
      clearTransientOverlays();
      setServerInfo((prev) => ({
        ...prev,
        connected: false,
        phase: "joining",
        reason: manual ? undefined : prev.reason,
      }));
      const ok = send({ type: "auth_cached", userId, serverId, mcVersion });
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
    [clearAutoReconnectTimer, clearTransientOverlays, mcVersion, send, serverId, state, userId],
  );

  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, completionMatches.length, scrollToBottom]);

  useEffect(
    () => () => {
      clearAutoReconnectTimer();
      clearOverlayTimers();
    },
    [clearAutoReconnectTimer, clearOverlayTimers],
  );

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
    if (state !== "open") resetMovementPanel();
  }, [resetMovementPanel, state]);

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

  const handleInputKeyPress = (
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    if (event.nativeEvent.key === "ArrowUp") {
      event.preventDefault?.();
      showPreviousInput();
      return;
    }
    if (event.nativeEvent.key === "ArrowDown") {
      event.preventDefault?.();
      showNextInput();
    }
  };

  const handleCompletionPress = (match: CompletionMatch) => {
    setInput((current) => applyCompletion(current, match.value));
    setCompletionMatches([]);
  };

  const handleSegmentClick = (segment: ChatSegment) => {
    const event = segment.clickEvent;
    if (!event) return;
    switch (event.action.toLowerCase()) {
      case "run_command":
        if (!serverInfo.connected) {
          Alert.alert("Not in server", "Reconnect before running this command.");
          return;
        }
        if (!send({ type: "send", text: event.value })) {
          Alert.alert("Not connected", "Wait for the bridge to reconnect.");
        }
        break;
      case "suggest_command":
        setInput(event.value);
        latestInputRef.current = event.value;
        setCompletionMatches([]);
        setTimeout(() => textInputRef.current?.focus(), 0);
        break;
      case "open_url":
        openExternalUrl(event.value);
        break;
      case "copy_to_clipboard":
        void Clipboard.setStringAsync(event.value).catch(() => {
          Alert.alert("Copy failed", event.value);
        });
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

  const handleWindowSlotPreview = (slot: GuiSlot) => {
    setPreviewWindowSlot(slot.index);
  };

  const handleWindowSlotSelect = (slot: GuiSlot) => {
    setSelectedWindowSlot(slot.index);
    setPreviewWindowSlot(slot.index);
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
    setPreviewWindowSlot(null);
    setPendingSlot(null);
  };

  const handleExitServer = () => {
    setOverflowOpen(false);
    resetMovementPanel();
    send({ type: "movement_stop_all" });
    send({ type: "position_unsubscribe" });
    send({ type: "map_unsubscribe" });
    send({ type: "logout" });
    onLogout();
  };

  const closeMovement = useCallback(() => {
    movementOpenRef.current = false;
    send({ type: "movement_stop_all" });
    send({ type: "position_unsubscribe" });
    send({ type: "map_unsubscribe" });
    resetMovementPanel();
  }, [resetMovementPanel, send]);

  const handlePlayerSelect = (player: PlayerSummary) => {
    const whisper = `/귓 ${player.name} `;
    setInput(whisper);
    latestInputRef.current = whisper;
    setCompletionMatches([]);
    setPlayerListOpen(false);
    setTimeout(() => textInputRef.current?.focus(), 50);
  };

  const onlineCount =
    publicStatus.online ?? serverInfo.online ?? (playerList.length > 0 ? playerList.length : undefined);
  const movementAllowed =
    MOVEMENT_PANEL_ENABLED &&
    ign.trim().toLowerCase() === MOVEMENT_TEST_IGN.trim().toLowerCase();

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 40 : 0}
    >
      <View style={styles.chatShell}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="서버에서 나가기"
            accessibilityRole="button"
            style={styles.backBtn}
            onPress={handleExitServer}
          >
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
            <Pressable
              accessibilityLabel="채팅 메뉴"
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.logoutBtn,
                pressed ? styles.logoutBtnPressed : null,
              ]}
              onPress={() => setOverflowOpen(true)}
            >
              <Text style={styles.logoutText}>•••</Text>
            </Pressable>
          </View>
        </View>

        {playerVitals ? <VitalsStrip vitals={playerVitals} /> : null}
        {bossBars.length > 0 ? <BossBarStack bars={bossBars} /> : null}
        {titleOverlay ? <TitleOverlay overlay={titleOverlay} /> : null}
        {actionBar ? (
          <ActionBarOverlay
            actionBar={actionBar}
            onSegmentClick={handleSegmentClick}
            onSegmentHover={handleSegmentHover}
          />
        ) : null}

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
            onKeyPress={handleInputKeyPress}
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
            mcVersion={mcVersion}
            selectedSlotIndex={selectedWindowSlot}
            previewSlotIndex={previewWindowSlot}
            pendingSlot={pendingSlot}
            onClose={handleWindowClose}
            onSlotPreview={handleWindowSlotPreview}
            onSlotSelect={handleWindowSlotSelect}
            onClickSelected={handleWindowSelectedClick}
          />
        ) : null}

        {tooltipText ? (
          <TooltipModal text={tooltipText} onClose={() => setTooltipText(null)} />
        ) : null}

        <OverflowMenuModal
          visible={overflowOpen}
          ign={ign}
          uuid={uuid}
          serverAddress={serverAddress}
          mcVersion={mcVersion}
          onlineCount={onlineCount}
          connected={serverInfo.connected}
          state={state}
          phase={serverInfo.phase}
          onClose={() => setOverflowOpen(false)}
          onReconnect={() => {
            setOverflowOpen(false);
            reconnect(true);
          }}
          onOpenPlayers={() => {
            setOverflowOpen(false);
            setPlayerListOpen(true);
          }}
          onOpenAppInfo={() => {
            setOverflowOpen(false);
            setAppInfoOpen(true);
          }}
          movementAllowed={movementAllowed}
          onOpenMovement={() => {
            setOverflowOpen(false);
            movementOpenRef.current = true;
            setPosition(null);
            setMapView(EMPTY_MAP_VIEW);
            setMovementOpen(true);
          }}
          onExitServer={handleExitServer}
        />

        {movementOpen && movementAllowed ? (
          <MovementModal
            connected={state === "open" && serverInfo.connected}
            position={position}
            map={mapView}
            mapEnabled={MAP_ENABLED}
            send={send}
            onPositionReset={() => setPosition(null)}
            onMapReset={() => setMapView(EMPTY_MAP_VIEW)}
            onClose={closeMovement}
          />
        ) : null}

        <AppInfoModal
          visible={appInfoOpen}
          serverAddress={serverAddress}
          mcVersion={mcVersion}
          onlineCount={onlineCount}
          connected={serverInfo.connected}
          state={state}
          phase={serverInfo.phase}
          onClose={() => setAppInfoOpen(false)}
        />

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

function openExternalUrl(url: string) {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) {
    Alert.alert("지원하지 않는 링크", String(url));
    return;
  }

  if (Platform.OS === "web") {
    const browser = globalThis as unknown as {
      open?: (url: string, target?: string, features?: string) => unknown;
    };
    const opened = browser.open?.(normalized, "_blank", "noopener,noreferrer");
    if (!opened) {
      Alert.alert("링크 열기 실패", normalized);
    }
    return;
  }

  void Linking.openURL(normalized).catch(() => {
    Alert.alert("링크 열기 실패", normalized);
  });
}

function normalizeExternalUrl(url: string): string | null {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function BossBarStack({ bars }: { bars: BossBarSummary[] }) {
  return (
    <View style={styles.bossBarStack}>
      {bars.slice(0, 3).map((bar) => (
        <View key={bar.id} style={styles.bossBarRow}>
          <View style={styles.bossBarHeader}>
            <Text style={styles.bossBarTitle} numberOfLines={1}>
              {bar.title}
            </Text>
            <Text style={styles.bossBarPct}>{Math.round(bar.health * 100)}%</Text>
          </View>
          <View style={styles.bossBarTrack}>
            <View
              style={[
                styles.bossBarFill,
                {
                  width: `${Math.max(2, Math.round(bar.health * 100))}%`,
                  backgroundColor: bossBarColor(bar.color),
                },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function ActionBarOverlay({
  actionBar,
  onSegmentClick,
  onSegmentHover,
}: {
  actionBar: ActionBarState;
  onSegmentClick: (segment: ChatSegment) => void;
  onSegmentHover: (segment: ChatSegment) => void;
}) {
  return (
    <View pointerEvents="box-none" style={styles.actionBarOverlay}>
      <View style={[styles.actionBarBubble, WEB_GLASS_BLUR]}>
        <RichText
          text={actionBar.text}
          segments={actionBar.segments}
          style={styles.actionBarText}
          onSegmentClick={onSegmentClick}
          onSegmentHover={onSegmentHover}
        />
      </View>
    </View>
  );
}

function TitleOverlay({ overlay }: { overlay: TitleOverlayState }) {
  return (
    <View pointerEvents="none" style={styles.titleOverlay}>
      <View style={[styles.titleOverlayContent, WEB_GLASS_BLUR]}>
        {overlay.title ? (
          <RichText
            text={overlay.title.text}
            segments={overlay.title.segments}
            style={styles.titleOverlayText}
            onSegmentClick={noopSegmentHandler}
            onSegmentHover={noopSegmentHandler}
          />
        ) : null}
        {overlay.subtitle ? (
          <RichText
            text={overlay.subtitle.text}
            segments={overlay.subtitle.segments}
            style={styles.titleOverlaySubtext}
            onSegmentClick={noopSegmentHandler}
            onSegmentHover={noopSegmentHandler}
          />
        ) : null}
      </View>
    </View>
  );
}

function noopSegmentHandler(_segment: ChatSegment) {
  // Title overlays are display-only; click handlers are intentionally inert.
}

function titleStayMs(timing: TitleTimingState): number {
  const stayTicks = Number.isFinite(timing.stay) && timing.stay > 0 ? timing.stay : 70;
  return Math.max(1500, Math.min(12000, stayTicks * 50));
}

function bossBarColor(color: string): string {
  switch (color) {
    case "pink":
      return "#ff7ad9";
    case "blue":
      return "#58a6ff";
    case "red":
      return "#f85149";
    case "green":
      return theme.accent;
    case "yellow":
      return "#f2cc60";
    case "white":
      return "#f0f6fc";
    case "purple":
    default:
      return "#a371f7";
  }
}

function VitalsStrip({ vitals }: { vitals: PlayerVitals }) {
  const health = typeof vitals.health === "number" ? vitals.health : null;
  const food = typeof vitals.food === "number" ? vitals.food : null;
  const level = typeof vitals.level === "number" ? vitals.level : null;
  const xpProgress = typeof vitals.xpProgress === "number" ? vitals.xpProgress : 0;
  if (health == null && food == null && level == null) return null;
  return (
    <View style={styles.vitalsStrip}>
      {health != null ? (
        <VitalMeter
          label="체력"
          value={`${Math.round(health)}/20`}
          progress={health / 20}
          tone="health"
        />
      ) : null}
      {food != null ? (
        <VitalMeter
          label="허기"
          value={`${Math.round(food)}/20`}
          progress={food / 20}
          tone="food"
        />
      ) : null}
      {level != null ? (
        <VitalMeter label="레벨" value={`${level}`} progress={xpProgress} tone="xp" />
      ) : null}
    </View>
  );
}

function VitalMeter({
  label,
  value,
  progress,
  tone,
}: {
  label: string;
  value: string;
  progress: number;
  tone: "health" | "food" | "xp";
}) {
  return (
    <View style={styles.vitalMeter}>
      <View style={styles.vitalCopy}>
        <Text style={styles.vitalLabel}>{label}</Text>
        <Text style={styles.vitalValue}>{value}</Text>
      </View>
      <View style={styles.vitalTrack}>
        <View
          style={[
            styles.vitalFill,
            { width: `${Math.max(3, Math.round(clamp01(progress) * 100))}%` },
            tone === "health" ? styles.vitalFillHealth : null,
            tone === "food" ? styles.vitalFillFood : null,
            tone === "xp" ? styles.vitalFillXp : null,
          ]}
        />
      </View>
    </View>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
  numberOfLines,
  interactive = true,
}: {
  text: string;
  segments?: ChatSegment[];
  style: object;
  onSegmentClick: (segment: ChatSegment) => void;
  onSegmentHover: (segment: ChatSegment) => void;
  numberOfLines?: number;
  interactive?: boolean;
}) {
  if (!segments?.length) {
    return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((segment, index) => {
        const clickable = interactive && Boolean(segment.clickEvent);
        const hoverable = interactive && Boolean(segment.hoverText);
        return (
          <Text
            key={`${index}-${segment.text}`}
            {...webHoverProps(interactive ? segment.hoverText : undefined)}
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

async function fetchPublicServerStatus(
  bridgeUrl: string,
  serverId: string,
): Promise<PublicServerStatus> {
  try {
    const url = new URL(bridgeUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/status";
    if (serverId) url.searchParams.set("serverId", serverId);

    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as {
      ok?: boolean;
      playersOnline?: unknown;
      stale?: unknown;
    };
    if (!body.ok || typeof body.playersOnline !== "number") return { ok: false };
    return {
      ok: true,
      online: body.playersOnline,
      stale: body.stale === true,
    };
  } catch {
    return { ok: false };
  }
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
    label = "종료";
    tone = "error";
  } else if (state === "open") {
    label = "입장중";
    tone = "warning";
  } else if (state === "connecting" || state === "closed") {
    label = "재연결";
    tone = "warning";
  }
  return <StatusPill label={label} tone={tone} style={styles.pill} />;
}

function connectionLabel(
  state: ConnectionState,
  connected: boolean,
  phase: "joining" | "online" | "offline" | "kicked",
): string {
  if (state === "open" && connected) return "접속됨";
  if (state === "open" && phase === "kicked") return "서버 종료";
  if (state === "open") return "입장중";
  if (state === "connecting" || state === "closed") return "재연결";
  return "오프라인";
}

function runtimeModeLabel(): string {
  if (Platform.OS !== "web") return Platform.OS === "ios" ? "iOS 앱" : "Android 앱";
  return isStandaloneWebApp() ? "홈 화면 앱" : "브라우저";
}

function isStandaloneWebApp(): boolean {
  if (Platform.OS !== "web") return false;
  const runtime = globalThis as typeof globalThis & {
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: Navigator & { standalone?: boolean };
  };
  return (
    Boolean(runtime.navigator?.standalone) ||
    Boolean(runtime.matchMedia?.("(display-mode: standalone)")?.matches) ||
    Boolean(runtime.matchMedia?.("(display-mode: fullscreen)")?.matches)
  );
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
    return "자동 재접속을 멈췄습니다. 재접속 버튼으로 다시 시도해 주세요.";
  }
  if (phase === "kicked") return `서버가 연결을 종료했습니다.${suffix}`;
  if (phase === "joining") return `서버 입장을 다시 시도 중입니다.${suffix}`;
  return `브릿지 연결을 복구 중입니다.${suffix}`;
}

function GuiWindowModal({
  gui,
  mcVersion,
  selectedSlotIndex,
  previewSlotIndex,
  pendingSlot,
  onClose,
  onSlotPreview,
  onSlotSelect,
  onClickSelected,
}: {
  gui: GuiWindow;
  mcVersion: string;
  selectedSlotIndex: number | null;
  previewSlotIndex: number | null;
  pendingSlot: number | null;
  onClose: () => void;
  onSlotPreview: (slot: GuiSlot) => void;
  onSlotSelect: (slot: GuiSlot) => void;
  onClickSelected: () => void;
}) {
  const visibleSlots = visibleGuiSlots(gui);
  const selectedSlot =
    selectedSlotIndex == null
      ? null
      : visibleSlots.find((slot) => slot.index === selectedSlotIndex) ?? null;
  const previewSlot =
    previewSlotIndex == null
      ? null
      : visibleSlots.find((slot) => slot.index === previewSlotIndex) ?? null;
  const detailSlot = previewSlot ?? selectedSlot;
  const detailItem = detailSlot?.item ?? null;
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

          <View style={styles.guiDetailCard}>
            {detailItem ? (
              <ScrollView
                style={styles.guiDetailScroll}
                contentContainerStyle={styles.guiDetailScrollContent}
                nestedScrollEnabled
              >
                <View style={styles.guiDetailTopRow}>
                  <MinecraftItemIcon
                    key={`${mcVersion}-${detailItem.name}`}
                    itemName={detailItem.name}
                    mcVersion={mcVersion}
                    head={detailItem.head}
                    fallbackLabel={shortItemLabel(detailItem)}
                    fallbackColor={itemColor(detailItem.name)}
                    size={44}
                    style={styles.guiDetailIcon}
                  />
                  <View style={styles.guiDetailCopy}>
                    <RichText
                      text={itemLabel(detailItem)}
                      segments={detailItem.displayNameSegments}
                      style={styles.guiDetailName}
                      onSegmentClick={noopSegmentHandler}
                      onSegmentHover={noopSegmentHandler}
                    />
                    <Text style={styles.guiDetailMeta} numberOfLines={1}>
                      슬롯 {detailSlot?.index ?? "-"} · {detailItem.name}
                      {selectedSlot?.index === detailSlot?.index ? " · 실행 대상" : ""}
                    </Text>
                  </View>
                </View>
                {detailItem.lore?.length ? (
                  <View style={styles.guiLoreList}>
                    {detailItem.lore.map((line, index) => (
                      <RichText
                        key={`${detailItem.name}-${index}-${line}`}
                        text={line}
                        segments={detailItem.loreSegments?.[index]}
                        style={styles.guiLoreText}
                        onSegmentClick={noopSegmentHandler}
                        onSegmentHover={noopSegmentHandler}
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.guiLoreEmpty}>표시할 로어 없음</Text>
                )}
              </ScrollView>
            ) : (
              <Text style={[styles.guiLoreEmpty, styles.guiDetailEmpty]}>
                {detailSlot ? `빈 슬롯 ${detailSlot.index}` : "슬롯에 마우스를 올리거나 탭하면 이름과 로어가 표시됩니다"}
              </Text>
            )}
          </View>

          <FlatList
            key={`gui-${gui.id}`}
            data={visibleSlots}
            keyExtractor={(slot) => `${gui.id}-${slot.index}`}
            numColumns={9}
            style={styles.guiGridList}
            contentContainerStyle={styles.guiGrid}
            renderItem={({ item }) => (
              <GuiSlotCell
                slot={item}
                mcVersion={mcVersion}
                selected={selectedSlotIndex === item.index}
                previewed={detailSlot?.index === item.index && selectedSlotIndex !== item.index}
                pending={pendingSlot === item.index}
                onPreview={() => onSlotPreview(item)}
                onSelect={() => onSlotSelect(item)}
              />
            )}
          />

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

function OverflowMenuModal({
  visible,
  ign,
  uuid,
  serverAddress,
  mcVersion,
  onlineCount,
  connected,
  state,
  phase,
  onClose,
  onReconnect,
  onOpenPlayers,
  onOpenAppInfo,
  movementAllowed,
  onOpenMovement,
  onExitServer,
}: {
  visible: boolean;
  ign: string;
  uuid?: string;
  serverAddress: string;
  mcVersion: string;
  onlineCount?: number;
  connected: boolean;
  state: ConnectionState;
  phase: "joining" | "online" | "offline" | "kicked";
  onClose: () => void;
  onReconnect: () => void;
  onOpenPlayers: () => void;
  onOpenAppInfo: () => void;
  movementAllowed: boolean;
  onOpenMovement: () => void;
  onExitServer: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overflowBackdrop}>
        <Pressable style={styles.overflowBackdropTouch} onPress={onClose} />
        <View style={[styles.overflowPanel, WEB_GLASS_BLUR]}>
          <View style={styles.overflowHeader}>
            <MinecraftHead uuid={uuid} size={48} style={styles.overflowHead} />
            <View style={styles.overflowCopy}>
              <Text style={styles.overflowTitle} numberOfLines={1}>
                {ign}
              </Text>
              <Text style={styles.overflowMeta} numberOfLines={1}>
                {serverAddress} · MC {mcVersion}
              </Text>
            </View>
          </View>

          <View style={styles.overflowStatusRow}>
            <ConnectionPill state={state} connected={connected} phase={phase} />
            <Text style={styles.overflowOnlineText}>
              {onlineCount != null ? `${onlineCount}명 접속 중` : "인원 수신 대기"}
            </Text>
          </View>

          <View style={styles.overflowRows}>
            <OverflowMenuRow
              title="재접속"
              subtitle="현재 계정으로 서버 연결을 다시 시도합니다"
              onPress={onReconnect}
            />
            <OverflowMenuRow
              title="플레이어 목록"
              subtitle="탭하면 귓속말 입력창에 닉네임을 불러옵니다"
              onPress={onOpenPlayers}
            />
            {movementAllowed ? (
              <OverflowMenuRow
                title="이동 및 좌표"
                subtitle="누르는 동안만 이동하며 창을 닫으면 즉시 멈춥니다"
                onPress={onOpenMovement}
              />
            ) : null}
            <OverflowMenuRow
              title="앱 정보"
              subtitle="실행 모드와 연결 보안 상태를 확인합니다"
              onPress={onOpenAppInfo}
            />
            <OverflowMenuRow
              title="서버에서 나가기"
              subtitle="서버에서 즉시 퇴장하고 계정 선택으로 이동합니다"
              danger
              onPress={onExitServer}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function MovementModal({
  connected,
  position,
  map,
  mapEnabled,
  send,
  onPositionReset,
  onMapReset,
  onClose,
}: {
  connected: boolean;
  position: PlayerPosition | null;
  map: MapViewState;
  mapEnabled: boolean;
  send: ReturnType<typeof useBridge>["send"];
  onPositionReset: () => void;
  onMapReset: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.movementBackdrop}>
        <Pressable style={styles.movementBackdropTouch} onPress={onClose} />
        <View style={[styles.movementSheet, WEB_GLASS_BLUR]}>
          <View style={styles.movementHeader}>
            <View style={styles.movementHeaderCopy}>
              <Text style={styles.movementTitle}>이동 및 좌표</Text>
              <Text style={styles.movementSubtitle}>손을 떼거나 창을 닫으면 즉시 정지합니다</Text>
            </View>
            <Pressable
              accessibilityLabel="이동 창 닫기"
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.movementClose,
                pressed ? styles.movementClosePressed : null,
              ]}
              onPress={onClose}
            >
              <Text style={styles.movementCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            showsVerticalScrollIndicator={false}
            style={styles.movementScroll}
          >
            <MovementPanel
              connected={connected}
              position={position}
              map={map}
              mapEnabled={mapEnabled}
              send={send}
              onPositionReset={onPositionReset}
              onMapReset={onMapReset}
              enabled
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function AppInfoModal({
  visible,
  serverAddress,
  mcVersion,
  onlineCount,
  connected,
  state,
  phase,
  onClose,
}: {
  visible: boolean;
  serverAddress: string;
  mcVersion: string;
  onlineCount?: number;
  connected: boolean;
  state: ConnectionState;
  phase: "joining" | "online" | "offline" | "kicked";
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.appInfoBackdrop}>
        <Pressable style={styles.appInfoBackdropTouch} onPress={onClose} />
        <View style={[styles.appInfoPanel, WEB_GLASS_BLUR]}>
          <View style={styles.appInfoHeader}>
            <View>
              <Text style={styles.appInfoTitle}>앱 정보</Text>
              <Text style={styles.appInfoSubtitle}>{runtimeModeLabel()}</Text>
            </View>
            <Pressable style={styles.appInfoCloseBtn} onPress={onClose}>
              <Text style={styles.appInfoCloseText}>×</Text>
            </Pressable>
          </View>

          <View style={styles.appInfoRows}>
            <AppInfoRow label="서버" value={serverAddress} />
            <AppInfoRow label="버전" value={`MC ${mcVersion}`} />
            <AppInfoRow label="상태" value={connectionLabel(state, connected, phase)} />
            <AppInfoRow label="백그라운드" value={BACKGROUND_SESSION_LABEL} />
            <AppInfoRow
              label="인원"
              value={onlineCount != null ? `${onlineCount}명` : "수신 대기"}
            />
            <AppInfoRow label="연결" value="임시 티켓" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AppInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.appInfoRow}>
      <Text style={styles.appInfoRowLabel}>{label}</Text>
      <Text style={styles.appInfoRowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function OverflowMenuRow({
  title,
  subtitle,
  danger = false,
  onPress,
}: {
  title: string;
  subtitle: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.overflowRow,
        pressed ? styles.overflowRowPressed : null,
      ]}
      onPress={onPress}
    >
      <Text style={[styles.overflowRowTitle, danger ? styles.overflowRowDanger : null]}>
        {title}
      </Text>
      <Text style={styles.overflowRowSubtitle}>{subtitle}</Text>
    </Pressable>
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
      <View style={styles.playerListBackdrop}>
        <Pressable style={styles.playerListBackdropTouch} onPress={onClose} />
        <View style={styles.playerListPanel}>
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
                    <RichText
                      text={`${item.displayName || item.name}${
                        item.name === currentIgn ? " · 나" : ""
                      }`}
                      segments={
                        item.displayNameSegments
                          ? [
                              ...item.displayNameSegments,
                              ...(item.name === currentIgn ? [{ text: " · 나" }] : []),
                            ]
                          : undefined
                      }
                      style={styles.playerRowName}
                      onSegmentClick={noopSegmentHandler}
                      onSegmentHover={noopSegmentHandler}
                      numberOfLines={1}
                      interactive={false}
                    />
                    <Text style={styles.playerRowMeta} numberOfLines={1}>
                      {item.displayName ? `${item.name} · 탭하면 귓속말 입력` : "탭하면 귓속말 입력"}
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
        </View>
      </View>
    </Modal>
  );
}

function GuiSlotCell({
  slot,
  mcVersion,
  selected,
  previewed,
  pending,
  onPreview,
  onSelect,
}: {
  slot: GuiSlot;
  mcVersion: string;
  selected: boolean;
  previewed: boolean;
  pending: boolean;
  onPreview: () => void;
  onSelect: () => void;
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
        previewed ? styles.guiSlotPreviewed : null,
        pressed ? styles.guiSlotPressed : null,
        pending ? styles.guiSlotPending : null,
      ]}
      onPress={onSelect}
      onHoverIn={onPreview}
      onLongPress={() => Alert.alert(`Slot ${slot.index}`, detail)}
    >
      {item ? (
        <>
          <MinecraftItemIcon
            key={`${mcVersion}-${item.name}`}
            itemName={item.name}
            mcVersion={mcVersion}
            head={item.head}
            fallbackLabel={label}
            fallbackColor={itemColor(item.name)}
            size={24}
          />
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

function validGuiSlotIndex(gui: GuiWindow, index: number | null): number | null {
  if (index == null) return null;
  return visibleGuiSlots(gui).some((slot) => slot.index === index) ? index : null;
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
  const normalized = name.replace(/^minecraft:/, "").toLowerCase();
  const colorMatch = ITEM_COLOR_PREFIXES.find(({ prefix }) => normalized.startsWith(prefix));
  if (colorMatch && COLORABLE_ITEM_RE.test(normalized)) {
    return colorMatch.color;
  }
  const materialMatch = ITEM_MATERIAL_COLORS.find(({ test }) => test.test(normalized));
  if (materialMatch) return materialMatch.color;

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

const ITEM_COLOR_PREFIXES = [
  { prefix: "white_", color: "#f0f0ec" },
  { prefix: "orange_", color: "#f9801d" },
  { prefix: "magenta_", color: "#c74ebd" },
  { prefix: "light_blue_", color: "#3ab3da" },
  { prefix: "yellow_", color: "#fed83d" },
  { prefix: "lime_", color: "#80c71f" },
  { prefix: "pink_", color: "#f38baa" },
  { prefix: "gray_", color: "#474f52" },
  { prefix: "light_gray_", color: "#9d9d97" },
  { prefix: "cyan_", color: "#169c9c" },
  { prefix: "purple_", color: "#8932b8" },
  { prefix: "blue_", color: "#3c44aa" },
  { prefix: "brown_", color: "#835432" },
  { prefix: "green_", color: "#5e7c16" },
  { prefix: "red_", color: "#b02e26" },
  { prefix: "black_", color: "#1d1d21" },
] as const;

const COLORABLE_ITEM_RE =
  /(stained_glass|stained_glass_pane|wool|carpet|concrete|concrete_powder|terracotta|glazed_terracotta|banner|bed|candle|shulker_box|dye)$/;

const ITEM_MATERIAL_COLORS = [
  { test: /end_crystal/, color: "#9b6dff" },
  { test: /player_head|player_wall_head/, color: "#d9b18c" },
  { test: /barrier|tnt|fire_charge|lava_bucket/, color: "#f85149" },
  { test: /emerald|slime|experience_bottle/, color: "#3fb950" },
  { test: /diamond|prismarine|heart_of_the_sea/, color: "#56d4dd" },
  { test: /gold|honey|glowstone|totem/, color: "#f2cc60" },
  { test: /iron|quartz|bone|paper|map/, color: "#c9d1d9" },
  { test: /redstone|nether_wart|ruby/, color: "#db3b32" },
  { test: /lapis|water_bucket/, color: "#4f8cff" },
  { test: /amethyst|chorus|dragon/, color: "#a371f7" },
  { test: /netherite|obsidian|blackstone|coal/, color: "#30363d" },
  { test: /book|chest|barrel|oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo/, color: "#a76b3f" },
] as const;

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
    position: "relative",
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
  logoutBtnPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.96 }],
    backgroundColor: "rgba(240, 246, 252, 0.1)",
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
  vitalsStrip: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
    backgroundColor: "rgba(13, 17, 23, 0.92)",
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  vitalMeter: {
    flex: 1,
    minWidth: 0,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "rgba(240, 246, 252, 0.04)",
    borderColor: "rgba(240, 246, 252, 0.08)",
    borderWidth: 1,
  },
  vitalCopy: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    marginBottom: 5,
  },
  vitalLabel: {
    color: theme.textDim,
    fontSize: 10,
    fontWeight: "900",
  },
  vitalValue: {
    color: theme.text,
    fontSize: 11,
    fontWeight: "900",
  },
  vitalTrack: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: "rgba(240, 246, 252, 0.1)",
  },
  vitalFill: {
    height: "100%",
    borderRadius: 2,
  },
  vitalFillHealth: {
    backgroundColor: "#f85149",
  },
  vitalFillFood: {
    backgroundColor: "#f2cc60",
  },
  vitalFillXp: {
    backgroundColor: theme.accent,
  },
  bossBarStack: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    gap: 7,
    backgroundColor: "rgba(13, 17, 23, 0.92)",
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  bossBarRow: {
    gap: 4,
  },
  bossBarHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bossBarTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.text,
    fontSize: 12,
    fontWeight: "900",
  },
  bossBarPct: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "900",
  },
  bossBarTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: "rgba(240, 246, 252, 0.12)",
  },
  bossBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  titleOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  titleOverlayContent: {
    maxWidth: 660,
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 18,
    backgroundColor: "rgba(13, 17, 23, 0.44)",
    borderColor: "rgba(240, 246, 252, 0.12)",
    borderWidth: 1,
  },
  titleOverlayText: {
    color: theme.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "900",
    textAlign: "center",
    textShadowColor: "rgba(0, 0, 0, 0.85)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  titleOverlaySubtext: {
    color: theme.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800",
    textAlign: "center",
    textShadowColor: "rgba(0, 0, 0, 0.85)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  actionBarOverlay: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 84,
    zIndex: 9,
    alignItems: "center",
  },
  actionBarBubble: {
    maxWidth: "100%",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: "rgba(13, 17, 23, 0.72)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    shadowColor: "#000000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  actionBarText: {
    color: theme.text,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "900",
    textAlign: "center",
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
    maxHeight: "86%",
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
  guiGridList: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 292,
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
  guiSlotPreviewed: {
    borderColor: "rgba(240, 246, 252, 0.5)",
    backgroundColor: "rgba(240, 246, 252, 0.08)",
  },
  guiSlotPending: {
    borderColor: theme.accentSoft,
    backgroundColor: "rgba(126, 231, 135, 0.15)",
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
    marginTop: 12,
    marginBottom: 2,
    borderRadius: 14,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    backgroundColor: "rgba(13, 17, 23, 0.76)",
    height: 156,
    overflow: "hidden",
  },
  guiDetailScroll: {
    flex: 1,
  },
  guiDetailScrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  guiDetailTopRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  guiDetailIcon: {
    marginVertical: 1,
  },
  guiDetailCopy: {
    flex: 1,
    minWidth: 0,
  },
  guiDetailEmpty: {
    paddingHorizontal: 12,
    paddingVertical: 10,
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
  overflowBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.42)",
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === "ios" ? 26 : 14,
  },
  overflowBackdropTouch: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  overflowPanel: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    zIndex: 1,
    backgroundColor: "rgba(13, 17, 23, 0.98)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 24,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
  },
  overflowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  overflowHead: {
    flexShrink: 0,
  },
  overflowCopy: {
    flex: 1,
    minWidth: 0,
  },
  overflowTitle: {
    color: theme.text,
    fontSize: 19,
    fontWeight: "900",
  },
  overflowMeta: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 4,
  },
  overflowStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  overflowOnlineText: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "800",
  },
  overflowRows: {
    paddingTop: 8,
    gap: 4,
  },
  overflowRow: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  overflowRowPressed: {
    backgroundColor: "rgba(240, 246, 252, 0.08)",
    transform: [{ scale: 0.99 }],
  },
  overflowRowTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900",
  },
  overflowRowDanger: {
    color: theme.danger,
  },
  overflowRowSubtitle: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  movementBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.42)",
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === "ios" ? 22 : 14,
  },
  movementBackdropTouch: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  movementSheet: {
    width: "100%",
    maxWidth: 460,
    maxHeight: "92%",
    zIndex: 1,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    backgroundColor: "rgba(13, 17, 23, 0.98)",
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.38,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 16 },
  },
  movementHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    paddingBottom: 12,
  },
  movementScroll: {
    flexShrink: 1,
  },
  movementHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  movementTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "900",
  },
  movementSubtitle: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  movementClose: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.cardElevated,
  },
  movementClosePressed: {
    backgroundColor: "rgba(240, 246, 252, 0.12)",
    transform: [{ scale: 0.96 }],
  },
  movementCloseText: {
    color: theme.text,
    fontSize: 28,
    lineHeight: 30,
    fontWeight: "700",
  },
  appInfoBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.42)",
    paddingHorizontal: 18,
  },
  appInfoBackdropTouch: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  appInfoPanel: {
    width: "100%",
    maxWidth: 390,
    zIndex: 1,
    backgroundColor: "rgba(13, 17, 23, 0.98)",
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 24,
    overflow: "hidden",
  },
  appInfoHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  appInfoTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900",
  },
  appInfoSubtitle: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 4,
  },
  appInfoCloseBtn: {
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
  appInfoCloseText: {
    color: theme.text,
    fontSize: 24,
    lineHeight: 27,
    fontWeight: "800",
  },
  appInfoRows: {
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  appInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    borderBottomColor: "rgba(240, 246, 252, 0.06)",
    borderBottomWidth: 1,
  },
  appInfoRowLabel: {
    width: 72,
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "800",
  },
  appInfoRowValue: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    fontWeight: "800",
    textAlign: "right",
  },
  playerListBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === "ios" ? 26 : 14,
  },
  playerListBackdropTouch: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
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
    zIndex: 1,
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
