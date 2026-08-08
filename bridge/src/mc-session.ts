import { EventEmitter } from "events";
import { createHash } from "crypto";
import mineflayer from "mineflayer";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import { normalizeAuthError } from "./auth";
import type {
  BossBarSummary,
  ChatSegment,
  CompletionMatch,
  GuiItem,
  GuiWindow,
  HeadDiagnostics,
  HeadFailureReason,
  HeadProfileBranch,
  HeadShapeDiagnostic,
  PlayerSummary,
  ServerMessage,
} from "./types";
import {
  componentPlainText,
  extractSender,
  plainText,
  rawJson,
  richSegments,
} from "./chat-format";
import {
  MOVEMENT_CONTROLS,
  MovementLeaseBook,
  toPlayerInputFlags,
  type MovementControl,
} from "./movement-control";
import { headingFromMineflayerYaw } from "./position-direction";
import { HEAD_DEBUG_ENABLED, HEAD_METADATA_ENABLED } from "./config";

type PlayerListMessage = Extract<ServerMessage, { type: "player_list" }>;
type BossBarsMessage = Extract<ServerMessage, { type: "boss_bars" }>;
type PlayerStateMessage = Extract<ServerMessage, { type: "player_state" }>;
type PositionMessage = Extract<ServerMessage, { type: "position" }>;
type SerializedLoreLine = { text: string; segments?: ChatSegment[] };

interface PositionSubscription {
  listener: (message: PositionMessage) => void;
  lastSignature: string;
  lastEmittedAt?: number;
}

const DEBUG_GUI_ITEMS = process.env.DEBUG_GUI_ITEMS === "1";
const POSITION_SYNC_MS = 250;
const POSITION_HEARTBEAT_MS = 1_000;
const POSITION_SAMPLE_WINDOW_MS = 3_000;
const POSITION_SAMPLE_LIMIT = 12;
const debuggedGuiItems = new Set<string>();

const MOVEMENT_EPOCH_EVENTS = [
  "start_configuration",
  "login",
  "respawn",
  "death",
  "mount",
] as const;
const MOVEMENT_DIAGNOSTIC_EVENTS = [
  ...MOVEMENT_EPOCH_EVENTS,
  "forcedMove",
] as const;

type MovementEpochEvent = (typeof MOVEMENT_EPOCH_EVENTS)[number];
export type MovementDiagnosticEvent = (typeof MOVEMENT_DIAGNOSTIC_EVENTS)[number];

export interface MovementEventDiagnostic {
  readonly count: number;
  readonly lastAt?: number;
}

export interface MovementPositionSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly ts: number;
}

export interface MovementPositionDelta {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly distance: number;
  readonly elapsedMs: number;
}

export interface MovementPositionDelta3s {
  readonly from: MovementPositionSample;
  readonly to: MovementPositionSample;
  readonly delta: MovementPositionDelta;
  readonly samples: readonly MovementPositionSample[];
}

export interface MovementDiagnostics {
  readonly controls: MovementControl[];
  readonly botControls: Record<MovementControl, boolean>;
  readonly physicsEnabled: boolean;
  readonly blockLoaded: boolean;
  readonly gameMode?: string;
  readonly velocity?: { readonly x: number; readonly y: number; readonly z: number };
  readonly movementEpoch: number;
  readonly teleportEpoch: number;
  readonly epochEvents: Record<MovementDiagnosticEvent, MovementEventDiagnostic>;
  readonly lastForcedMoveAt?: number;
  readonly lastPhysicsTickAt?: number;
  readonly loadedColumns: number;
  readonly positionDelta3s?: MovementPositionDelta3s;
}

export interface HeadInspection {
  readonly head?: GuiItem["head"];
  readonly diagnostic: HeadShapeDiagnostic;
}

export interface McSessionOptions {
  host: string;
  port: number;
  version: string;
  serverId?: string;
  serverName?: string;
  username: string;          // Microsoft email / cache key
  profilesFolder: string;    // prismarine-auth cache directory for this user
}

interface RingBuffer {
  push(msg: ServerMessage): void;
  snapshot(): ServerMessage[];
}

function makeRing(size: number): RingBuffer {
  const buf: ServerMessage[] = [];
  return {
    push(msg) {
      buf.push(msg);
      if (buf.length > size) buf.splice(0, buf.length - size);
    },
    snapshot() {
      return buf.slice();
    },
  };
}

// Wraps a single mineflayer bot instance. Emits ServerMessage events that
// the WS layer forwards to the user's connected clients. Handles graceful
// shutdown and exposes a method to send chat back into the game.
export class McSession extends EventEmitter {
  private bot: Bot | null = null;
  private readonly history = makeRing(50);
  private readonly cookies = new Map<string, Buffer>();
  private shuttingDown = false;
  private connected = false;
  private ended = false;
  private lastChatAt = 0;
  private currentGuiWindow: Window | null = null;
  private currentGuiWindowListener: ((...args: unknown[]) => void) | null = null;
  private playerListTimer: NodeJS.Timeout | null = null;
  private lastPlayerListSignature = "";
  private lastBossBarsSignature = "";
  private lastPlayerStateSignature = "";
  private readonly suppressedBossBarIds = new Set<string>();
  private readonly movementLeases = new MovementLeaseBook();
  private readonly positionSubscriptions = new Map<string, PositionSubscription>();
  private positionTimer: NodeJS.Timeout | null = null;
  private movementWatchdogTimer: NodeJS.Timeout | null = null;
  private movementEpoch = 0;
  private teleportEpoch = 0;
  private readonly epochEvents: Record<
    MovementDiagnosticEvent,
    MovementEventDiagnostic
  > = {
    start_configuration: { count: 0 },
    login: { count: 0 },
    respawn: { count: 0 },
    death: { count: 0 },
    mount: { count: 0 },
    forcedMove: { count: 0 },
  };
  private lastForcedMoveAt: number | undefined;
  private lastPhysicsTickAt: number | undefined;
  private readonly movementPositionSamples: MovementPositionSample[] = [];
  private readonly headDiagnosticShapes = new Set<string>();
  private readonly headDiagnosticCounters: {
    headsSeen: number;
    headsWithHeadField: number;
    byBranch: Record<HeadProfileBranch, number>;
    byFailureReason: Record<HeadFailureReason, number>;
  } = {
    headsSeen: 0,
    headsWithHeadField: 0,
    byBranch: {
      componentMap: 0,
      component: 0,
      "legacy-nbt": 0,
      none: 0,
    },
    byFailureReason: {
      "no-profile": 0,
      "bad-base64": 0,
      "non-canonical": 0,
      oversize: 0,
      "bad-json": 0,
      "bad-scheme": 0,
      "bad-host": 0,
      "bad-id": 0,
    },
  };

  // Anti-AFK: nudge the bot every ~3 minutes so the server doesn't kick it.
  private antiAfkTimer: NodeJS.Timeout | null = null;
  private configurationRestartTimer: NodeJS.Timeout | null = null;
  private packetActivityTimer: NodeJS.Timeout | null = null;
  private lastInboundPacketAt = 0;

  constructor(
    private readonly opts: McSessionOptions,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  start(): void {
    if (this.bot) return;
    this.ended = false;
    this.lastInboundPacketAt = Date.now();
    console.info(
      `[mc-session] starting ${this.opts.host}:${this.opts.port} mc=${this.opts.version}`,
    );
    const bot = mineflayer.createBot({
      host: this.opts.host,
      port: this.opts.port,
      version: this.opts.version,
      username: this.opts.username,
      auth: "microsoft",
      profilesFolder: this.opts.profilesFolder,
      // Some proxy/limbo handoffs can leave long gaps between keepalive
      // packets even though chat/system packets are still flowing.
      checkTimeoutInterval: 30 * 60 * 1000,
      // Prevent prismarine-auth from prompting on the *server* console — we
      // already completed the device-code flow before starting the bot.
      // (If the cached token is invalid we want a hard failure rather than
      // a hidden prompt.)
      onMsaCode: () => {
        this.emitMsg({
          type: "auth_failed",
          reason: "Cached Microsoft token expired. Please log in again.",
        });
      },
    });
    this.bot = bot;
    this.patchClientSettingsWrite(bot);
    this.wireEvents(bot);
    this.wireProtocolCompat(bot);
    this.startPacketActivityWatchdog();
  }

  private patchClientSettingsWrite(bot: Bot): void {
    const client = bot._client as unknown as {
      state?: string;
      write(name: string, params?: Record<string, unknown>): void;
    };
    const originalWrite = client.write.bind(client);

    client.write = (name: string, params: Record<string, unknown> = {}) => {
      if (client.state === "configuration" && !CONFIGURATION_SERVERBOUND_PACKETS.has(name)) {
        return;
      }
      if (name === "settings") {
        originalWrite(name, withCompleteClientSettings(params));
        return;
      }
      originalWrite(name, params);
    };
  }

  private disableUnusedSimulation(bot: Bot): void {
    // Mineflayer installs control helpers during plugin initialization, so this
    // must run from the spawn handler rather than immediately after createBot.
    // Chat/command control does not need client-side physics ticks. Keeping
    // them off lowers idle CPU on the Mac mini bridge without affecting chat,
    // tab completion, GUI clicks, or anti-AFK look packets.
    bot.clearControlStates();
    bot.physicsEnabled = false;
  }

  private wireEvents(bot: Bot): void {
    bot.once("spawn", () => {
      this.disableUnusedSimulation(bot);
      const ign = bot.username;
      const uuid = (bot as unknown as { uuid?: string }).uuid ?? "";
      console.info(`[mc-session] spawned ign=${ign} mc=${this.opts.version}`);
      this.emitMsg({ type: "auth_ok", userId: ign, ign, uuid });
      this.markConnected();
      this.startPlayerListSync();
      this.startPositionSync();
      this.startAntiAfk();
    });

    const emitPlayersSoon = () => {
      setTimeout(() => this.emitPlayerList(), 0);
    };
    bot.on("playerJoined", emitPlayersSoon);
    bot.on("playerLeft", emitPlayersSoon);
    bot.on("playerUpdated", emitPlayersSoon);
    bot.on("health", () => {
      this.emitPlayerState();
    });
    bot.on("experience", () => {
      this.emitPlayerState();
    });
    bot.on("physicsTick", () => {
      this.lastPhysicsTickAt = this.now();
      const active = this.movementLeases.activeControls();
      if (active.size > 0) this.writeMovementInput(bot, active);
    });
    bot.on("login", () => this.recordMovementEpoch("login"));
    bot.on("respawn", () => this.recordMovementEpoch("respawn"));
    bot.on("death", () => this.recordMovementEpoch("death"));
    bot.on("mount", () => this.recordMovementEpoch("mount"));
    bot.on("forcedMove", () => this.recordForcedMove());

    const emitBossBarsSoon = (bar?: { entityUUID?: string }) => {
      if (typeof bar?.entityUUID === "string") {
        this.suppressedBossBarIds.delete(bar.entityUUID);
      }
      setTimeout(() => this.emitBossBars(), 0);
    };
    bot.on("bossBarCreated", emitBossBarsSoon);
    bot.on("bossBarUpdated", emitBossBarsSoon);
    bot.on("bossBarDeleted", (bar?: { entityUUID?: string }) => {
      if (typeof bar?.entityUUID === "string") {
        this.suppressedBossBarIds.delete(bar.entityUUID);
      }
      setTimeout(() => this.emitBossBars(), 0);
    });

    bot.on("actionBar", (jsonMsg: unknown) => {
      const text = plainText(jsonMsg as never);
      if (!text.trim()) return;
      this.emitMsg({
        type: "action_bar",
        text,
        ts: Date.now(),
        segments: richSegments(jsonMsg as never),
        rawJson: rawJson(jsonMsg as never),
      });
    });

    bot.on("title", (component: unknown, type: "title" | "subtitle") => {
      const normalized = plainText(component as never).trim();
      if (!normalized) return;
      this.emitMsg({
        type: "title",
        event: "text",
        part: type,
        text: normalized,
        ts: Date.now(),
        segments: richSegments(component as never),
        rawJson: rawJson(component as never) ?? component,
      });
    });

    (bot as unknown as EventEmitter).on("title_times", (fadeIn: number, stay: number, fadeOut: number) => {
      this.emitMsg({
        type: "title",
        event: "times",
        fadeIn,
        stay,
        fadeOut,
        ts: Date.now(),
      });
    });

    (bot as unknown as EventEmitter).on("title_clear", () => {
      this.emitMsg({
        type: "title",
        event: "clear",
        ts: Date.now(),
      });
    });

    // `messagestr` is mineflayer's "any chat-like message" event including
    // system messages, deaths, joins, leaves. Use the underlying ChatMessage
    // (3rd arg) for sender extraction and JSON.
    bot.on(
      "messagestr",
      (
        text: string,
        position: string,
        jsonMsg: unknown,
      ) => {
        this.markConnected();
        if (position === "game_info") return;
        const sender = extractSender(jsonMsg as never);
        if (sender) {
          this.emitMsg({
            type: "chat",
            from: sender,
            fromUuid: this.playerUuid(sender),
            text: plainText(jsonMsg as never),
            ts: Date.now(),
            segments: richSegments(jsonMsg as never),
            rawJson: rawJson(jsonMsg as never),
          });
        } else {
          this.emitMsg({
            type: "system",
            text,
            ts: Date.now(),
            segments: richSegments(jsonMsg as never),
            rawJson: rawJson(jsonMsg as never),
          });
        }
      },
    );

    bot.on("kicked", (reason: unknown) => {
      const normalized = normalizeKickReason(reason);
      console.warn(`[mc-session] kicked reason=${normalized}`);
      this.stopAllMovement();
      this.clearPositionSubscriptions();
      this.emitMsg({
        type: "kicked",
        reason: normalized,
      });
    });

    bot.on("end", (reason: string) => {
      this.finishDisconnected(reason || "ended");
    });

    bot.on("error", (err: Error) => {
      const reason = normalizeRuntimeError(err);
      console.error(`[mc-session] bot error reason=${reason}`, err);
      if (isMicrosoftAuthError(err)) {
        this.emitMsg({
          type: "auth_failed",
          reason: normalizeAuthError(err).message,
        });
        this.finishDisconnected(reason);
        return;
      }
      this.emitMsg({ type: "error", text: reason });
      if (!this.connected) {
        this.finishDisconnected(reason);
      }
    });

    bot.on("windowOpen", (window) => {
      this.attachGuiWindow(window);
      this.emitWindowSnapshot("window_open", window);
    });

    bot.on("windowClose", (window) => {
      const windowId = typeof window?.id === "number" ? window.id : undefined;
      this.detachGuiWindow();
      this.emitMsg({ type: "window_close", windowId });
    });
  }

  private wireProtocolCompat(bot: Bot): void {
    const client = bot._client as unknown as {
      on(event: string, listener: (packet: never) => void): void;
      write(name: string, params: Record<string, unknown>): void;
      state?: string;
    };
    const clientEmitter = client as unknown as EventEmitter;
    allowProxyConfigurationRestarts(clientEmitter);

    client.on("packet", () => {
      this.lastInboundPacketAt = Date.now();
    });

    client.on("start_configuration", () => {
      this.recordMovementEpoch("start_configuration");
      dedupeProtocolOnceListeners(clientEmitter, [
        "select_known_packs",
        "code_of_conduct",
        "finish_configuration",
      ]);
      this.clearBossBars();
      this.emitMsg({
        type: "system",
        text: "Server requested configuration restart.",
        ts: Date.now(),
      });
      this.armConfigurationRestartWatchdog(client);
      this.writeConfigurationSettingsWhenReady(client);
    });

    client.on("finish_configuration", () => {
      this.clearConfigurationRestartWatchdog();
    });

    client.on("store_cookie", (packet: { key?: string; value?: Buffer }) => {
      if (packet.key && packet.value) {
        this.cookies.set(packet.key, packet.value);
      }
    });

    client.on("cookie_request", (packet: { cookie?: string }) => {
      const key = packet.cookie;
      if (!key) return;
      try {
        client.write("cookie_response", {
          key,
          value: this.cookies.get(key),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.emitMsg({ type: "error", text: `cookie response failed: ${reason}` });
      }
    });

    client.on("transfer", (packet: { host?: string; port?: number }) => {
      const host = packet.host ?? "unknown";
      const port = packet.port ?? 25565;
      this.clearBossBars();
      this.emitMsg({
        type: "system",
        text: `Server requested transfer to ${host}:${port}.`,
        ts: Date.now(),
      });
    });
  }

  // Forward a chat message or command from an app user into the game. The
  // message appears in-game as the user's own player.
  sendChat(text: string, rateLimitPerSec: number): { ok: true } | { ok: false; reason: string } {
    if (!this.bot) return { ok: false, reason: "not connected" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty" };
    if (trimmed.length > 256) {
      return { ok: false, reason: "message exceeds 256 chars" };
    }
    const minGapMs = Math.max(50, Math.floor(1000 / Math.max(1, rateLimitPerSec)));
    const now = Date.now();
    if (now - this.lastChatAt < minGapMs) {
      return { ok: false, reason: "rate limited" };
    }
    this.lastChatAt = now;
    this.bot.chat(trimmed);
    return { ok: true };
  }

  async complete(text: string): Promise<CompletionMatch[]> {
    const bot = this.bot as
      | (Bot & {
          tabComplete?: (
            text: string,
            assumeCommand?: boolean,
            sendBlockInSight?: boolean,
            timeout?: number,
          ) => Promise<unknown[]>;
        })
      | null;
    const query = text.slice(0, 256);
    if (!bot || !this.connected || !query.trim()) return [];
    try {
      const matches = await bot.tabComplete?.(
        query,
        query.startsWith("/"),
        false,
        3000,
      );
      return normalizeCompletions(matches);
    } catch {
      // Some servers intentionally do not answer completion requests for
      // certain commands or while plugins are busy. Treat that as "no matches"
      // instead of surfacing a red chat error to the user.
      return [];
    }
  }

  async clickWindow(
    slot: number,
    mouseButton: 0 | 1 = 0,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bot = this.bot;
    const window = bot?.currentWindow ?? this.currentGuiWindow;
    if (!bot || !this.connected) return { ok: false, reason: "not connected" };
    if (!window) return { ok: false, reason: "no open window" };
    if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length) {
      return { ok: false, reason: "invalid slot" };
    }
    if (mouseButton !== 0 && mouseButton !== 1) {
      return { ok: false, reason: "invalid mouse button" };
    }

    try {
      await bot.clickWindow(slot, mouseButton, 0);
      const updated = bot.currentWindow ?? this.currentGuiWindow;
      if (updated) this.emitWindowSnapshot("window_update", updated);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  closeWindow(): { ok: true } | { ok: false; reason: string } {
    const bot = this.bot;
    const window = bot?.currentWindow ?? this.currentGuiWindow;
    if (!bot || !this.connected) return { ok: false, reason: "not connected" };
    if (!window) return { ok: false, reason: "no open window" };

    try {
      bot.closeWindow(window);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  setMovementControl(
    clientId: string,
    control: MovementControl,
    pressed: boolean,
    holdMs: number,
  ): { ok: true } | { ok: false; reason: string } {
    const bot = this.bot;
    if (pressed && (!bot || !this.connected)) {
      return { ok: false, reason: "not connected" };
    }
    if (pressed) {
      this.movementLeases.press(clientId, control, holdMs, this.now());
    } else {
      this.movementLeases.release(clientId, control);
    }
    this.syncMovementControls();
    this.armMovementWatchdog();
    return { ok: true };
  }

  stopMovementForClient(clientId: string): void {
    if (!this.movementLeases.stopClient(clientId)) return;
    this.syncMovementControls();
    this.armMovementWatchdog();
  }

  private stopAllMovement(): void {
    this.movementLeases.stopAll();
    this.syncMovementControls();
    this.stopMovementWatchdog();
  }

  isMovementActive(): boolean {
    return this.movementLeases.isActive();
  }

  movementClientCount(): number {
    return this.movementLeases.activeClientCount();
  }

  movementDiagnostics(): MovementDiagnostics {
    const bot = this.bot;
    const position = bot?.entity?.position;
    const velocity = bot?.entity?.velocity;
    return {
      controls: [...this.movementLeases.activeControls()],
      botControls: Object.fromEntries(
        MOVEMENT_CONTROLS.map((control) => [
          control,
          bot?.getControlState(control) === true,
        ]),
      ) as Record<MovementControl, boolean>,
      physicsEnabled: bot?.physicsEnabled === true,
      blockLoaded: Boolean(bot && position && bot.blockAt(position, false)),
      gameMode: bot?.game?.gameMode,
      velocity: velocity
        ? { x: velocity.x, y: velocity.y, z: velocity.z }
        : undefined,
      movementEpoch: this.movementEpoch,
      teleportEpoch: this.teleportEpoch,
      epochEvents: {
        start_configuration: { ...this.epochEvents.start_configuration },
        login: { ...this.epochEvents.login },
        respawn: { ...this.epochEvents.respawn },
        death: { ...this.epochEvents.death },
        mount: { ...this.epochEvents.mount },
        forcedMove: { ...this.epochEvents.forcedMove },
      },
      lastForcedMoveAt: this.lastForcedMoveAt,
      lastPhysicsTickAt: this.lastPhysicsTickAt,
      loadedColumns: bot ? bot.world.getColumns().length : 0,
      positionDelta3s: this.positionDelta3s(),
    };
  }

  headDiagnostics(): HeadDiagnostics {
    return {
      headsSeen: this.headDiagnosticCounters.headsSeen,
      headsWithHeadField: this.headDiagnosticCounters.headsWithHeadField,
      byBranch: { ...this.headDiagnosticCounters.byBranch },
      byFailureReason: { ...this.headDiagnosticCounters.byFailureReason },
    };
  }

  private recordHeadDiagnostic(
    inspection: HeadInspection,
    hasHeadField: boolean,
  ): void {
    if (!HEAD_DEBUG_ENABLED) return;
    this.headDiagnosticCounters.headsSeen += 1;
    if (hasHeadField) this.headDiagnosticCounters.headsWithHeadField += 1;
    const { diagnostic } = inspection;
    this.headDiagnosticCounters.byBranch[diagnostic.branch] += 1;
    if (diagnostic.failureReason) {
      this.headDiagnosticCounters.byFailureReason[diagnostic.failureReason] += 1;
    }

    const signature = JSON.stringify(diagnostic);
    if (
      this.headDiagnosticShapes.has(signature) ||
      this.headDiagnosticShapes.size >= 40
    ) {
      return;
    }
    this.headDiagnosticShapes.add(signature);
    console.info(`[mc-session] head_shape ${signature}`);
  }

  private recordMovementEpoch(event: MovementEpochEvent): void {
    const now = this.now();
    this.movementEpoch += 1;
    this.epochEvents[event] = {
      count: this.epochEvents[event].count + 1,
      lastAt: now,
    };
  }

  private recordForcedMove(): void {
    const now = this.now();
    this.teleportEpoch = this.movementEpoch;
    this.lastForcedMoveAt = now;
    this.epochEvents.forcedMove = {
      count: this.epochEvents.forcedMove.count + 1,
      lastAt: now,
    };
  }

  private recordPositionSample(position: PositionMessage): void {
    this.movementPositionSamples.push({
      x: position.x,
      y: position.y,
      z: position.z,
      ts: position.ts,
    });
    const windowStart = position.ts - POSITION_SAMPLE_WINDOW_MS;
    while (this.movementPositionSamples[0]?.ts < windowStart) {
      this.movementPositionSamples.shift();
    }
    if (this.movementPositionSamples.length > POSITION_SAMPLE_LIMIT) {
      this.movementPositionSamples.splice(
        0,
        this.movementPositionSamples.length - POSITION_SAMPLE_LIMIT,
      );
    }
  }

  private positionDelta3s(): MovementPositionDelta3s | undefined {
    const from = this.movementPositionSamples[0];
    const to = this.movementPositionSamples.at(-1);
    if (!from || !to) return undefined;
    const x = to.x - from.x;
    const y = to.y - from.y;
    const z = to.z - from.z;
    return {
      from: { ...from },
      to: { ...to },
      delta: {
        x,
        y,
        z,
        distance: Math.hypot(x, y, z),
        elapsedMs: to.ts - from.ts,
      },
      samples: this.movementPositionSamples.map((sample) => ({ ...sample })),
    };
  }

  // Push a message to listeners and store it in the per-user history ring.
  private emitMsg(msg: ServerMessage): void {
    if (msg.type === "chat" || msg.type === "system") {
      this.history.push(msg);
    }
    this.emit("message", msg);
  }

  private attachGuiWindow(window: Window): void {
    this.detachGuiWindow();
    this.currentGuiWindow = window;
    this.currentGuiWindowListener = () => {
      this.emitWindowSnapshot("window_update", window);
    };
    (window as unknown as EventEmitter).on("updateSlot", this.currentGuiWindowListener);
  }

  private detachGuiWindow(): void {
    if (this.currentGuiWindow && this.currentGuiWindowListener) {
      (this.currentGuiWindow as unknown as EventEmitter).off(
        "updateSlot",
        this.currentGuiWindowListener,
      );
    }
    this.currentGuiWindow = null;
    this.currentGuiWindowListener = null;
  }

  private emitWindowSnapshot(type: "window_open" | "window_update", window: Window): void {
    this.emitMsg({
      type,
      window: serializeWindow(window, (inspection, hasHeadField) => {
        this.recordHeadDiagnostic(inspection, hasHeadField);
      }),
    });
  }

  history50(): ServerMessage[] {
    return this.history.snapshot();
  }

  isConnected(): boolean {
    return this.bot != null && this.connected;
  }

  statusSnapshot(): ServerMessage | null {
    if (!this.bot || !this.connected) return null;
    return {
      type: "status",
      connected: true,
      server: `${this.opts.host}:${this.opts.port}`,
      serverId: this.opts.serverId,
      serverName: this.opts.serverName,
      ign: this.bot.username,
      playersOnline: Object.keys(this.bot.players ?? {}).length,
    };
  }

  summary(): {
    connected: boolean;
    ign?: string;
    playersOnline?: number;
  } {
    const bot = this.bot;
    return {
      connected: Boolean(bot && this.connected),
      ign: bot?.username,
      playersOnline: bot ? Object.keys(bot.players ?? {}).length : undefined,
    };
  }

  shutdown(reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopAntiAfk();
    this.stopAllMovement();
    this.clearPositionSubscriptions();
    this.clearConfigurationRestartWatchdog();
    this.stopPacketActivityWatchdog();
    this.detachGuiWindow();
    this.stopPlayerListSync();
    this.lastBossBarsSignature = "";
    this.lastPlayerStateSignature = "";
    this.suppressedBossBarIds.clear();
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try {
        bot.quit(reason);
      } catch {
        // ignore — socket may already be dead
      }
    }
  }

  private finishDisconnected(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    const normalizedReason = reason || "ended";
    console.warn(`[mc-session] ended reason=${normalizedReason}`);
    this.stopAntiAfk();
    this.stopAllMovement();
    this.clearPositionSubscriptions();
    this.clearConfigurationRestartWatchdog();
    this.stopPacketActivityWatchdog();
    this.detachGuiWindow();
    this.stopPlayerListSync();
    this.lastBossBarsSignature = "";
    this.lastPlayerStateSignature = "";
    this.suppressedBossBarIds.clear();
    this.connected = false;
    const bot = this.bot;
    this.bot = null;
    this.emitMsg({
      type: "status",
      connected: false,
      server: `${this.opts.host}:${this.opts.port}`,
      serverId: this.opts.serverId,
      serverName: this.opts.serverName,
      reason: normalizedReason,
    });
    this.emit("ended", normalizedReason);
    if (bot && !this.shuttingDown) {
      try {
        bot.quit(normalizedReason);
      } catch {
        // ignore
      }
    }
  }

  private startAntiAfk(): void {
    this.stopAntiAfk();
    this.antiAfkTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot) return;
      try {
        // Tiny look nudge — not visible movement, but enough packet activity
        // to defeat most idle-kick plugins.
        bot.look(bot.entity.yaw + 0.01, bot.entity.pitch, false);
      } catch {
        // ignore
      }
    }, 3 * 60 * 1000);
  }

  private stopAntiAfk(): void {
    if (this.antiAfkTimer) {
      clearInterval(this.antiAfkTimer);
      this.antiAfkTimer = null;
    }
  }

  private markConnected(): void {
    if (!this.bot || this.connected) return;
    this.connected = true;
    this.emitMsg({
      type: "status",
      connected: true,
      server: `${this.opts.host}:${this.opts.port}`,
      serverId: this.opts.serverId,
      serverName: this.opts.serverName,
      ign: this.bot.username,
      playersOnline: Object.keys(this.bot.players ?? {}).length,
    });
    this.emitPlayerList();
    this.emitBossBars();
    this.emitPlayerState(true);
    this.emitPosition(true);
  }

  private startPlayerListSync(): void {
    this.stopPlayerListSync();
    this.emitPlayerList();
    this.playerListTimer = setInterval(() => {
      this.emitPlayerList();
    }, 10_000);
  }

  private stopPlayerListSync(): void {
    if (!this.playerListTimer) return;
    clearInterval(this.playerListTimer);
    this.playerListTimer = null;
    this.lastPlayerListSignature = "";
  }

  private emitPlayerList(force = false): void {
    const msg = this.playerListSnapshot();
    if (!msg) return;
    const signature = JSON.stringify(msg.players.map((player) => [
      player.name,
      player.uuid ?? "",
      player.displayName ?? "",
      player.ping ?? "",
    ]));
    if (!force && signature === this.lastPlayerListSignature) return;
    this.lastPlayerListSignature = signature;
    this.emitMsg(msg);
  }

  playerListSnapshot(): PlayerListMessage | null {
    if (!this.bot || !this.connected) return null;
    const players = serializePlayerList(this.bot);
    return {
      type: "player_list",
      playersOnline: players.length,
      players,
      ts: Date.now(),
    };
  }

  private emitBossBars(force = false): void {
    const msg = this.bossBarsSnapshot();
    if (!msg) return;
    const signature = JSON.stringify(msg.bars);
    if (!force && signature === this.lastBossBarsSignature) return;
    this.lastBossBarsSignature = signature;
    this.emitMsg(msg);
  }

  private clearBossBars(): void {
    for (const bar of this.currentBossBars(false)) {
      this.suppressedBossBarIds.add(bar.id);
    }
    this.lastBossBarsSignature = "[]";
    this.emitMsg({
      type: "boss_bars",
      bars: [],
      ts: Date.now(),
    });
  }

  bossBarsSnapshot(): BossBarsMessage | null {
    if (!this.bot || !this.connected) return null;
    return {
      type: "boss_bars",
      bars: this.currentBossBars(),
      ts: Date.now(),
    };
  }

  private emitPlayerState(force = false): void {
    const msg = this.playerStateSnapshot();
    if (!msg) return;
    const signature = JSON.stringify([
      msg.health ?? "",
      msg.food ?? "",
      msg.saturation ?? "",
      msg.level ?? "",
      msg.xpProgress ?? "",
    ]);
    if (!force && signature === this.lastPlayerStateSignature) return;
    this.lastPlayerStateSignature = signature;
    this.emitMsg(msg);
  }

  playerStateSnapshot(): PlayerStateMessage | null {
    const bot = this.bot;
    if (!bot || !this.connected) return null;
    const experience = (bot as unknown as {
      experience?: { level?: unknown; progress?: unknown };
    }).experience;
    const health = finiteNumber((bot as unknown as { health?: unknown }).health);
    const food = finiteNumber((bot as unknown as { food?: unknown }).food);
    const saturation = finiteNumber((bot as unknown as { foodSaturation?: unknown }).foodSaturation);
    const level = finiteNumber(experience?.level);
    const xpProgress = finiteNumber(experience?.progress);
    if (
      health == null &&
      food == null &&
      saturation == null &&
      level == null &&
      xpProgress == null
    ) {
      return null;
    }
    return {
      type: "player_state",
      health: clampRange(health, 0, 20),
      food: clampRange(food, 0, 20),
      saturation: clampRange(saturation, 0, 20),
      level: level == null ? undefined : Math.max(0, Math.floor(level)),
      xpProgress: clamp01(xpProgress ?? 0),
      ts: Date.now(),
    };
  }

  positionSnapshot(): PositionMessage | null {
    const bot = this.bot;
    if (!bot || !this.connected || !bot.entity) return null;
    const { position, yaw, onGround } = bot.entity;
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(yaw)
    ) {
      return null;
    }
    const heading = headingFromMineflayerYaw(yaw);
    return {
      type: "position",
      x: position.x,
      y: position.y,
      z: position.z,
      yaw: heading.yaw,
      direction: heading.direction,
      dimension: bot.game?.dimension,
      grounded: typeof onGround === "boolean" ? onGround : undefined,
      ts: this.now(),
    };
  }

  startPositionSubscriptionForClient(
    clientId: string,
    listener: (message: PositionMessage) => void,
  ): void {
    const existing = this.positionSubscriptions.get(clientId);
    if (existing) {
      existing.listener = listener;
      return;
    }
    const subscription: PositionSubscription = {
      listener,
      lastSignature: "",
    };
    this.positionSubscriptions.set(clientId, subscription);
    this.startPositionSync();
    const message = this.positionSnapshot();
    if (message) {
      this.deliverPosition(clientId, subscription, message, true);
    }
  }

  stopPositionSubscriptionForClient(clientId: string): void {
    if (!this.positionSubscriptions.delete(clientId)) return;
    if (this.positionSubscriptions.size === 0) this.stopPositionSync();
  }

  positionSubscriberCount(): number {
    return this.positionSubscriptions.size;
  }

  isPositionSyncActive(): boolean {
    return this.positionTimer != null;
  }

  private startPositionSync(): void {
    if (this.positionTimer || this.positionSubscriptions.size === 0) return;
    this.positionTimer = setInterval(() => this.emitPosition(), POSITION_SYNC_MS);
  }

  private stopPositionSync(): void {
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = null;
  }

  private clearPositionSubscriptions(): void {
    this.positionSubscriptions.clear();
    this.stopPositionSync();
  }

  private emitPosition(force = false): void {
    const msg = this.positionSnapshot();
    if (!msg) return;
    this.recordPositionSample(msg);
    for (const [clientId, subscription] of this.positionSubscriptions) {
      this.deliverPosition(clientId, subscription, msg, force);
    }
  }

  private deliverPosition(
    clientId: string,
    subscription: PositionSubscription,
    msg: PositionMessage,
    force: boolean,
  ): void {
    try {
      this.emitPositionToSubscription(subscription, msg, force);
    } catch (error) {
      console.error("[mc-session] position subscriber failed", error);
      this.positionSubscriptions.delete(clientId);
      if (this.positionSubscriptions.size === 0) this.stopPositionSync();
    }
  }

  private emitPositionToSubscription(
    subscription: PositionSubscription,
    msg: PositionMessage,
    force: boolean,
  ): void {
    const signature = [
      msg.x.toFixed(3),
      msg.y.toFixed(3),
      msg.z.toFixed(3),
      msg.yaw.toFixed(1),
      msg.dimension ?? "",
      msg.grounded ?? "",
    ].join(":");
    const heartbeatDue =
      subscription.lastEmittedAt == null ||
      msg.ts - subscription.lastEmittedAt >= POSITION_HEARTBEAT_MS;
    if (
      !force &&
      signature === subscription.lastSignature &&
      !heartbeatDue
    ) {
      return;
    }
    subscription.lastSignature = signature;
    subscription.lastEmittedAt = msg.ts;
    subscription.listener(msg);
  }

  private syncMovementControls(): void {
    const bot = this.bot;
    if (!bot) return;
    const active = this.movementLeases.activeControls();
    bot.clearControlStates();
    if (active.size === 0) {
      // Modern servers retain the last player_input flags until the client
      // explicitly sends a neutral packet. Send it before pausing physics so
      // release, lease expiry, disconnect, and shutdown cannot leave stale
      // movement active server-side.
      this.writeMovementInput(bot, active);
      bot.physicsEnabled = false;
      return;
    }
    bot.physicsEnabled = true;
    for (const control of MOVEMENT_CONTROLS) {
      if (active.has(control)) bot.setControlState(control, true);
    }
    this.writeMovementInput(bot, active);
  }

  private writeMovementInput(
    bot: Bot,
    controls: ReadonlySet<MovementControl>,
  ): void {
    if (!bot.supportFeature("newPlayerInputPacket")) return;
    try {
      bot._client.write("player_input", {
        inputs: toPlayerInputFlags(controls),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[mc-session] failed to write player_input reason=${reason}`);
    }
  }

  private armMovementWatchdog(): void {
    this.stopMovementWatchdog();
    const expiresAt = this.movementLeases.nextExpiryAt();
    if (expiresAt == null) return;
    this.movementWatchdogTimer = setTimeout(() => {
      this.movementWatchdogTimer = null;
      this.expireMovementLeases();
      this.armMovementWatchdog();
    }, Math.max(0, expiresAt - this.now()));
  }

  private expireMovementLeases(): void {
    if (this.movementLeases.expire(this.now())) {
      this.syncMovementControls();
    }
  }

  private stopMovementWatchdog(): void {
    if (this.movementWatchdogTimer) clearTimeout(this.movementWatchdogTimer);
    this.movementWatchdogTimer = null;
  }

  private currentBossBars(filterSuppressed = true): BossBarSummary[] {
    if (!this.bot) return [];
    const bars = serializeBossBars(this.bot).filter((bar) => !isTransientLimboBossBar(bar));
    if (!filterSuppressed || this.suppressedBossBarIds.size === 0) return bars;
    return bars.filter((bar) => !this.suppressedBossBarIds.has(bar.id));
  }

  private playerUuid(username: string): string | undefined {
    const player = this.bot?.players?.[username] as { uuid?: string } | undefined;
    return typeof player?.uuid === "string" ? player.uuid : undefined;
  }

  private writeConfigurationSettingsWhenReady(client: {
    state?: string;
    write(name: string, params: Record<string, unknown>): void;
  }): void {
    let wrote = false;
    const tryWrite = () => {
      if (wrote || client.state !== "configuration") return;
      wrote = true;
      try {
        writeClientSettings(client);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[mc-session] failed to write configuration settings", err);
        this.emitMsg({ type: "error", text: `configuration settings failed: ${reason}` });
      }
    };

    queueMicrotask(tryWrite);
    setImmediate(tryWrite);
    setTimeout(tryWrite, 5);
  }

  private armConfigurationRestartWatchdog(client: { state?: string }): void {
    this.clearConfigurationRestartWatchdog();
    this.configurationRestartTimer = setTimeout(() => {
      this.configurationRestartTimer = null;
      if (!this.bot || client.state !== "configuration") return;
      this.finishDisconnected("configuration restart did not finish");
    }, 45_000);
  }

  private clearConfigurationRestartWatchdog(): void {
    if (!this.configurationRestartTimer) return;
    clearTimeout(this.configurationRestartTimer);
    this.configurationRestartTimer = null;
  }

  private startPacketActivityWatchdog(): void {
    this.stopPacketActivityWatchdog();
    this.packetActivityTimer = setInterval(() => {
      if (!this.bot || this.shuttingDown) return;
      const idleMs = Date.now() - this.lastInboundPacketAt;
      if (idleMs < 90_000) return;
      this.finishDisconnected(`server stopped sending packets for ${idleMs}ms`);
    }, 30_000);
  }

  private stopPacketActivityWatchdog(): void {
    if (!this.packetActivityTimer) return;
    clearInterval(this.packetActivityTimer);
    this.packetActivityTimer = null;
  }
}

function normalizeCompletions(matches: unknown[] | undefined): CompletionMatch[] {
  if (!Array.isArray(matches)) return [];
  const normalized: CompletionMatch[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    let value: string | undefined;
    let tooltip: string | undefined;
    if (typeof match === "string") {
      value = match;
    } else if (match && typeof match === "object") {
      const obj = match as { match?: unknown; value?: unknown; tooltip?: unknown };
      if (typeof obj.match === "string") value = obj.match;
      if (typeof obj.value === "string") value = obj.value;
      if (typeof obj.tooltip === "string") tooltip = obj.tooltip;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push({ value, tooltip });
    if (normalized.length >= 24) break;
  }
  return normalized;
}

function serializePlayerList(bot: Bot): PlayerSummary[] {
  const players = Object.entries(bot.players ?? {})
    .map(([key, player]) => {
      const normalized = player as {
        username?: unknown;
        uuid?: unknown;
        displayName?: unknown;
        ping?: unknown;
      };
      const name =
        typeof normalized.username === "string" && normalized.username.trim()
          ? normalized.username.trim()
          : key;
      const uuid = typeof normalized.uuid === "string" ? normalized.uuid : undefined;
      const displayName = componentPlainText(normalized.displayName);
      const displayNameSegments = richSegments(normalized.displayName as never);
      const hasStyledDisplayName = Boolean(
        displayNameSegments?.some(
          (segment) =>
            segment.color ||
            segment.bold ||
            segment.italic ||
            segment.underlined ||
            segment.strikethrough,
        ),
      );
      const visibleDisplayName =
        displayName && (displayName !== name || hasStyledDisplayName) ? displayName : undefined;
      const ping = typeof normalized.ping === "number" ? normalized.ping : undefined;
      return {
        name,
        uuid,
        displayName: visibleDisplayName,
        displayNameSegments: visibleDisplayName ? displayNameSegments : undefined,
        ping,
      };
    })
    .filter((player) => player.name)
    .sort((a, b) => {
      if (a.name === bot.username) return -1;
      if (b.name === bot.username) return 1;
      return a.name.localeCompare(b.name, "en");
    });

  return players.slice(0, 200);
}

function serializeBossBars(bot: Bot): BossBarSummary[] {
  const source = (bot as unknown as { bossBars?: unknown }).bossBars;
  const bars = bossBarValues(source)
    .map((bar) => serializeBossBar(bar))
    .filter((bar): bar is BossBarSummary => Boolean(bar));
  return bars.slice(0, 6);
}

function isTransientLimboBossBar(bar: BossBarSummary): boolean {
  const normalizedTitle = bar.title.replace(/\s/g, "").toLowerCase();
  return (
    normalizedTitle.includes("접속대기중") ||
    normalizedTitle.includes("connecting") ||
    normalizedTitle.includes("limbo")
  );
}

function bossBarValues(source: unknown): unknown[] {
  if (!source) return [];
  if (source instanceof Map) return [...source.values()];
  if (Array.isArray(source)) return source;
  if (typeof source === "object") return Object.values(source as Record<string, unknown>);
  return [];
}

function serializeBossBar(bar: unknown): BossBarSummary | null {
  if (!bar || typeof bar !== "object") return null;
  const obj = bar as {
    entityUUID?: unknown;
    title?: unknown;
    health?: unknown;
    color?: unknown;
    dividers?: unknown;
  };
  const id = typeof obj.entityUUID === "string" ? obj.entityUUID : undefined;
  if (!id) return null;
  return {
    id,
    title: bossBarTitle(obj.title),
    health: clamp01(typeof obj.health === "number" ? obj.health : 0),
    color: typeof obj.color === "string" ? obj.color : "purple",
    dividers: typeof obj.dividers === "number" ? obj.dividers : undefined,
  };
}

function bossBarTitle(title: unknown): string {
  return componentPlainText(title) || plainText(title as never) || "Boss Bar";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampRange(value: number | undefined, min: number, max: number): number | undefined {
  return value == null ? undefined : Math.max(min, Math.min(max, value));
}

function serializeWindow(
  window: Window,
  recordHeadDiagnostic?: (
    inspection: HeadInspection,
    hasHeadField: boolean,
  ) => void,
): GuiWindow {
  return {
    id: window.id,
    type: String(window.type),
    title: normalizeWindowTitle(window.title),
    slotCount: window.slots.length,
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    hotbarStart: window.hotbarStart,
    selectedItem: serializeItem(window.selectedItem, recordHeadDiagnostic),
    slots: window.slots.map((item, index) => ({
      index,
      item: serializeItem(item, recordHeadDiagnostic),
    })),
  };
}

function serializeItem(
  item: Item | null | undefined,
  recordHeadDiagnostic?: (
    inspection: HeadInspection,
    hasHeadField: boolean,
  ) => void,
): GuiItem | null {
  if (!item) return null;
  const displayNameSource = firstNonEmptyComponent([
    item.customName,
    readItemComponent(item, [
      "minecraft:custom_name",
      "custom_name",
      "customName",
      "Name",
      "minecraft:item_name",
      "item_name",
      "itemName",
      "minecraft:display_name",
      "display_name",
      "displayName",
    ]),
    readItemNbtDisplayField(item, "Name"),
  ]);
  const customDisplayName = componentPlainText(displayNameSource);
  const rawLore = firstNonEmptyLore([
    item.customLore,
    readItemComponent(item, ["minecraft:lore", "lore", "Lore", "customLore"]),
    readItemComponent(item, ["minecraft:tooltip", "tooltip", "Tooltips"]),
    readItemNbtDisplayField(item, "Lore"),
  ]);
  const inferredDisplayName = !customDisplayName ? rawLore[0]?.text : undefined;
  const displayName = customDisplayName || inferredDisplayName || item.displayName;
  const displayNameSegments =
    richSegments(displayNameSource as never) ??
    (!customDisplayName && rawLore[0]?.segments ? rawLore[0].segments : undefined);
  const loreLines = inferredDisplayName ? rawLore.slice(1) : rawLore;
  const lore = loreLines.map((line) => line.text);
  const loreSegments = loreLines.map((line) => line.segments).some(Boolean)
    ? loreLines.map((line) => line.segments ?? [{ text: line.text }])
    : undefined;
  const headInspection =
    (item.name === "player_head" || item.name === "player_wall_head") &&
    (HEAD_METADATA_ENABLED || HEAD_DEBUG_ENABLED)
      ? inspectHeadInfo(item)
      : undefined;
  const head = HEAD_METADATA_ENABLED ? headInspection?.head : undefined;
  if (headInspection && recordHeadDiagnostic) {
    recordHeadDiagnostic(headInspection, Boolean(head));
  }
  debugGuiItem(item, displayName, lore);
  return {
    name: item.name,
    displayName,
    displayNameSegments,
    count: item.count,
    type: item.type,
    metadata: item.metadata,
    lore: lore.length > 0 ? lore : undefined,
    loreSegments,
    head,
  };
}

const MAX_ENCODED_HEAD_TEXTURE_BYTES = 8 * 1024;
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const TEXTURE_ID_RE = /^[0-9a-f]{40,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_PROFILE_DEBUG_KEYS = new Set([
  "Id",
  "Name",
  "Properties",
  "SKIN",
  "Signature",
  "SkullOwner",
  "Textures",
  "UUID",
  "Value",
  "body",
  "cape",
  "data",
  "elytra",
  "id",
  "minecraft:profile",
  "model",
  "name",
  "profile",
  "properties",
  "signature",
  "skinPatch",
  "textures",
  "type",
  "url",
  "uuid",
  "value",
]);

export function extractHeadInfo(
  item: Item | null | undefined,
): GuiItem["head"] | undefined {
  return inspectHeadInfo(item).head;
}

export function inspectHeadInfo(
  item: Item | null | undefined,
): HeadInspection {
  try {
    if (
      !item ||
      (item.name !== "player_head" && item.name !== "player_wall_head")
    ) {
      return {
        diagnostic: emptyHeadDiagnostic("none", "no-profile"),
      };
    }

    const source = readHeadProfile(item);
    const record = profileRecord(source.profile);
    if (!record) {
      return {
        diagnostic: {
          ...emptyHeadDiagnostic(source.branch, "no-profile"),
          profileKeys: profileKeys(source.profile),
        },
      };
    }

    const uuidValue = firstField(record, ["uuid", "UUID", "id", "Id"]);
    const nameValue = firstField(record, ["name", "Name"]);
    const playerUuid = sanitizePlayerUuid(uuidValue);
    const playerName = sanitizePlayerName(nameValue);
    const textureValue = texturePropertyValue(
      firstField(record, ["properties", "Properties"]),
    );
    const textureResult = textureValue
      ? textureIdFromEncodedProfile(textureValue)
      : undefined;
    const textureId = textureResult?.textureId;
    const head =
      playerUuid || playerName || textureId
        ? {
            ...(playerUuid ? { playerUuid } : {}),
            ...(playerName ? { playerName } : {}),
            ...(textureId ? { textureId } : {}),
          }
        : undefined;
    return {
      head,
      diagnostic: {
        branch: source.branch,
        profileKeys: profileKeys(source.profile),
        hasUuid: uuidValue != null,
        hasName: nameValue != null,
        hasTextures: textureValue != null,
        nameValid: playerName != null,
        uuidValid: playerUuid != null,
        ...(textureResult?.failureReason
          ? { failureReason: textureResult.failureReason }
          : {}),
        ...(textureId && HEAD_DEBUG_ENABLED
          ? {
              textureIdHash8: createHash("sha256")
                .update(textureId)
                .digest("hex")
                .slice(0, 8),
            }
          : {}),
      },
    };
  } catch {
    return {
      diagnostic: emptyHeadDiagnostic("none", "no-profile"),
    };
  }
}

function emptyHeadDiagnostic(
  branch: HeadProfileBranch,
  failureReason: HeadFailureReason,
): HeadShapeDiagnostic {
  return {
    branch,
    profileKeys: [],
    hasUuid: false,
    hasName: false,
    hasTextures: false,
    nameValid: false,
    uuidValid: false,
    failureReason,
  };
}

function readHeadProfile(
  item: Item,
): { readonly branch: HeadProfileBranch; readonly profile: unknown } {
  const componentMap = (item as unknown as Record<string, unknown>).componentMap;
  if (componentMap instanceof Map) {
    for (const key of ["profile", "minecraft:profile"]) {
      if (componentMap.has(key)) {
        const profile = componentPayload(componentMap.get(key));
        if (profile != null) {
          return {
            branch: "componentMap",
            profile,
          };
        }
      }
    }
  }
  const component = readItemComponent(item, ["minecraft:profile", "profile"]);
  if (component != null) {
    return { branch: "component", profile: component };
  }
  const legacy = readLegacySkullOwner(item);
  return legacy == null
    ? { branch: "none", profile: undefined }
    : { branch: "legacy-nbt", profile: legacy };
}

function readLegacySkullOwner(item: Item): unknown {
  const root = unwrapNbtValue(
    (item as unknown as Record<string, unknown>).nbt,
  );
  if (!root || typeof root !== "object" || root instanceof Map) {
    return undefined;
  }
  const record = root as Record<string, unknown>;
  return record.SkullOwner ?? record.skullOwner;
}

function profileRecord(value: unknown): Record<string, unknown> | undefined {
  const normalized = unwrapNbtValue(value);
  if (typeof normalized === "string") {
    return { name: normalized };
  }
  if (!normalized || typeof normalized !== "object" || normalized instanceof Map) {
    return undefined;
  }

  const root = normalized as Record<string, unknown>;
  const candidates = [
    root,
    unwrapNbtValue(root.profile),
    unwrapNbtValue(root.data),
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      !(candidate instanceof Map)
    ) {
      const record = candidate as Record<string, unknown>;
      if (
        ["uuid", "UUID", "id", "Id", "name", "Name", "properties", "Properties"]
          .some((key) => key in record)
      ) {
        return record;
      }
    }
  }
  return undefined;
}

function profileKeys(value: unknown): string[] {
  const normalized = unwrapNbtValue(value);
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized) ||
    normalized instanceof Map
  ) {
    return [];
  }
  return Object.keys(normalized as Record<string, unknown>)
    .sort()
    .slice(0, 24)
    .map((key) => redactIdentityBearingKey(key, true));
}

function firstField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function sanitizePlayerName(value: unknown): string | undefined {
  const name = stringValue(value);
  return name && PLAYER_NAME_RE.test(name) ? name : undefined;
}

function sanitizePlayerUuid(value: unknown): string | undefined {
  const normalized = unwrapNbtValue(value);
  let compact: string | undefined;

  if (typeof normalized === "string") {
    compact = normalized.trim().toLowerCase().replaceAll("-", "");
  } else if (
    Array.isArray(normalized) &&
    normalized.length === 4 &&
    normalized.every((part) => Number.isInteger(part))
  ) {
    compact = normalized
      .map((part) => ((part as number) >>> 0).toString(16).padStart(8, "0"))
      .join("");
  } else if (normalized instanceof Uint8Array && normalized.length === 16) {
    compact = Buffer.from(normalized).toString("hex");
  }

  if (!compact || !/^[0-9a-f]{32}$/.test(compact)) return undefined;
  const dashed = [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
  return UUID_RE.test(dashed) ? dashed : undefined;
}

function texturePropertyValue(properties: unknown): string | undefined {
  const normalized = unwrapNbtValue(properties);
  if (Array.isArray(normalized)) {
    for (const entry of normalized) {
      const record = propertyRecord(entry);
      if (!record) continue;
      const name = stringValue(record.name ?? record.Name);
      if (name !== "textures") continue;
      const value = stringValue(record.value ?? record.Value);
      if (value) return value;
    }
    return undefined;
  }

  if (
    normalized &&
    typeof normalized === "object" &&
    !(normalized instanceof Map)
  ) {
    const record = normalized as Record<string, unknown>;
    const textures = record.textures ?? record.Textures;
    return firstStringValue(textures);
  }
  return undefined;
}

function propertyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || value instanceof Map) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if ("name" in raw || "Name" in raw || "Value" in raw) return raw;
  const normalized = unwrapNbtValue(value);
  return normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized) &&
    !(normalized instanceof Map)
    ? (normalized as Record<string, unknown>)
    : undefined;
}

function firstStringValue(value: unknown): string | undefined {
  const pending = [value];
  const visited = new Set<object>();
  for (let count = 0; pending.length > 0 && count < 32; count += 1) {
    const current = pending.shift();
    const direct = stringValue(current);
    if (direct) return direct;
    const normalized = unwrapNbtValue(current);
    if (!normalized || typeof normalized !== "object") continue;
    if (visited.has(normalized)) continue;
    visited.add(normalized);
    if (Array.isArray(normalized)) {
      pending.push(...normalized);
      continue;
    }
    if (normalized instanceof Map) {
      pending.push(...normalized.values());
      continue;
    }
    const record = normalized as Record<string, unknown>;
    pending.push(record.Value, record.value);
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  const normalized = unwrapNbtValue(value);
  return typeof normalized === "string" && normalized.length > 0
    ? normalized
    : undefined;
}

function textureIdFromEncodedProfile(
  encoded: string,
): { readonly textureId?: string; readonly failureReason?: HeadFailureReason } {
  if (encoded.length > MAX_ENCODED_HEAD_TEXTURE_BYTES) {
    return { failureReason: "oversize" };
  }
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { failureReason: "bad-base64" };
  }

  try {
    const decoded = Buffer.from(encoded, "base64");
    const canonical = decoded.toString("base64").replace(/=+$/, "");
    if (canonical !== encoded.replace(/=+$/, "")) {
      return { failureReason: "non-canonical" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(decoded.toString("utf8")) as unknown;
    } catch {
      return { failureReason: "bad-json" };
    }
    if (!payload || typeof payload !== "object") {
      return { failureReason: "bad-json" };
    }
    const textures = (payload as Record<string, unknown>).textures;
    if (!textures || typeof textures !== "object") {
      return { failureReason: "bad-json" };
    }
    const skin = (textures as Record<string, unknown>).SKIN;
    if (!skin || typeof skin !== "object") {
      return { failureReason: "bad-json" };
    }
    const urlValue = (skin as Record<string, unknown>).url;
    if (typeof urlValue !== "string") {
      return { failureReason: "bad-json" };
    }

    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      return { failureReason: "bad-host" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { failureReason: "bad-scheme" };
    }
    if (
      url.hostname !== "textures.minecraft.net" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return { failureReason: "bad-host" };
    }
    if (url.search || url.hash) {
      return { failureReason: "bad-id" };
    }
    const match = /^\/texture\/([0-9a-f]{40,64})$/.exec(url.pathname);
    return match && TEXTURE_ID_RE.test(match[1])
      ? { textureId: match[1] }
      : { failureReason: "bad-id" };
  } catch {
    return { failureReason: "bad-json" };
  }
}

function debugGuiItem(item: Item, displayName: string, lore: string[]): void {
  if (!DEBUG_GUI_ITEMS) return;
  const summary = summarizeItemForDebug(item, displayName, lore);
  const key = JSON.stringify(summary);
  if (debuggedGuiItems.has(key) || debuggedGuiItems.size >= 40) return;
  debuggedGuiItems.add(key);
  console.log(`[bridge] gui_item ${key}`);
}

export function summarizeItemForDebug(
  item: Item,
  displayName: string,
  lore: string[],
): Record<string, unknown> {
  const obj = item as unknown as Record<string, unknown>;
  return {
    name: item.name,
    displayName: summarizeValue(displayName),
    lore: summarizeValue(lore),
    customName: summarizeValue(obj.customName),
    customLore: summarizeValue(obj.customLore),
    componentKeys: componentKeys(item),
    components: summarizeValue(obj.components),
    componentMap: summarizeValue(obj.componentMap),
    nbt: summarizeValue(obj.nbt),
  };
}

function componentKeys(item: Item): string[] {
  const obj = item as unknown as Record<string, unknown>;
  const keys = new Set<string>();
  const components = obj.components;
  if (Array.isArray(components)) {
    for (const component of components) {
      const normalized = unwrapNbtValue(component);
      if (!normalized || typeof normalized !== "object") continue;
      const record = normalized as Record<string, unknown>;
      const key = record.type ?? record.name ?? record.key;
      if (typeof key === "string") keys.add(key);
    }
  }
  const componentMap = obj.componentMap;
  if (componentMap instanceof Map) {
    for (const key of componentMap.keys()) {
      if (typeof key === "string") keys.add(key);
    }
  }
  return [...keys].sort();
}

interface DebugSummaryContext {
  readonly depth: number;
  readonly profile: boolean;
  readonly properties: boolean;
  readonly field?: string;
}

function summarizeValue(
  value: unknown,
  context: DebugSummaryContext = {
    depth: 0,
    profile: false,
    properties: false,
  },
): unknown {
  const normalized = unwrapNbtValue(value);
  if (normalized == null) return normalized;
  if (typeof normalized === "string") {
    const redaction = debugRedactionKind(normalized, context);
    if (redaction) return `<redacted:${redaction}:${normalized.length}>`;
    return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
  }
  if (
    typeof normalized === "number" ||
    typeof normalized === "boolean"
  ) {
    return normalized;
  }
  if (context.depth >= 6) return "[Object]";
  if (normalized instanceof Map) {
    const entries: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entryValue] of normalized.entries()) {
      if (count >= 12) break;
      const field = String(key);
      entries[redactIdentityBearingKey(field, context.profile)] = summarizeValue(
        entryValue,
        childDebugSummaryContext(context, field),
      );
      count += 1;
    }
    return entries;
  }
  if (Array.isArray(normalized)) {
    return normalized.slice(0, 12).map((entry) =>
      summarizeValue(entry, {
        ...context,
        depth: context.depth + 1,
      }),
    );
  }
  if (typeof normalized === "object") {
    const record = normalized as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const profile =
      context.profile ||
      ["type", "key"].some((key) => {
        const candidate = stringValue(record[key]);
        return candidate === "profile" || candidate === "minecraft:profile";
      });
    for (const key of Object.keys(record).slice(0, 16)) {
      out[redactIdentityBearingKey(key, profile)] = summarizeValue(
        record[key],
        childDebugSummaryContext({ ...context, profile }, key),
      );
    }
    return out;
  }
  return String(normalized);
}

function childDebugSummaryContext(
  context: DebugSummaryContext,
  field: string,
): DebugSummaryContext {
  const normalizedField = field.toLowerCase();
  const profile =
    context.profile ||
    normalizedField === "profile" ||
    normalizedField === "minecraft:profile" ||
    normalizedField === "skullowner";
  return {
    depth: context.depth + 1,
    profile,
    properties:
      context.properties ||
      (profile &&
        (normalizedField === "properties" ||
          normalizedField === "minecraft:properties")),
    field,
  };
}

function debugRedactionKind(
  value: string,
  context: DebugSummaryContext,
): "uuid" | "name" | "texture" | undefined {
  if (
    UUID_RE.test(value.toLowerCase()) ||
    /^[0-9a-f]{32}$/i.test(value)
  ) {
    return "uuid";
  }
  if (/^eyJ[A-Za-z0-9+/_=-]+$/.test(value)) return "texture";
  if (!context.profile || !context.field) return undefined;

  const field = context.field.toLowerCase();
  if (!SAFE_PROFILE_DEBUG_KEYS.has(context.field)) return "name";
  if (field === "uuid" || field === "id" || field === "profileid") {
    return "uuid";
  }
  if (
    field === "name" ||
    field === "profilename" ||
    field === "profile" ||
    field === "skullowner"
  ) {
    return "name";
  }
  if (
    context.properties &&
    (field === "value" || field === "signature")
  ) {
    return "texture";
  }
  return undefined;
}

function redactIdentityBearingKey(key: string, profile: boolean): string {
  return (profile && !SAFE_PROFILE_DEBUG_KEYS.has(key)) ||
    UUID_RE.test(key.toLowerCase()) ||
    /^[0-9a-f]{32}$/i.test(key) ||
    /^eyJ[A-Za-z0-9+/_=-]+$/.test(key) ||
    key.length > 64
    ? `<redacted:key:${key.length}>`
    : key;
}

function firstNonEmptyComponent(candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (componentPlainText(candidate)) return candidate;
  }
  return undefined;
}

function firstNonEmptyLore(candidates: unknown[]): SerializedLoreLine[] {
  for (const candidate of candidates) {
    const lore = serializeItemLore(candidate);
    if (lore.length > 0) return lore;
  }
  return [];
}

function serializeItemLore(lore: unknown): SerializedLoreLine[] {
  const normalized = unwrapNbtValue(lore);
  const lines = extractLoreLines(normalized);
  const serialized: SerializedLoreLine[] = [];
  for (const line of lines) {
    const text = componentPlainText(line);
    const segments = richSegments(line as never);
    const splitLines = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (splitLines.length <= 1) {
      const single = splitLines[0];
      if (single) serialized.push({ text: single, segments });
      continue;
    }
    for (const splitLine of splitLines) {
      serialized.push({
        text: splitLine,
        segments: richSegments(splitLine as never),
      });
    }
  }
  return serialized;
}

function extractLoreLines(value: unknown): unknown[] {
  const normalized = unwrapNbtValue(value);
  if (Array.isArray(normalized)) return normalized;
  if (typeof normalized === "string") return [normalized];
  if (!normalized || typeof normalized !== "object") return [];

  const obj = normalized as Record<string, unknown>;
  for (const key of ["lines", "lore", "Lore", "value"]) {
    const nested = extractLoreLines(obj[key]);
    if (nested.length > 0) return nested;
  }
  return [];
}

function readItemComponent(item: Item, keys: string[]): unknown {
  const sources = componentSources(item);
  for (const source of sources) {
    const value = readComponentSource(source, keys);
    if (value != null) return value;
  }
  return undefined;
}

function componentSources(item: Item): unknown[] {
  const obj = item as unknown as Record<string, unknown>;
  return [
    obj.components,
    obj.componentMap,
    obj.rawComponents,
    obj.nbt,
    obj.nbt && typeof obj.nbt === "object"
      ? (obj.nbt as Record<string, unknown>).components
      : undefined,
  ].filter((source) => source != null);
}

function readComponentSource(source: unknown, keys: string[]): unknown {
  const normalized = unwrapNbtValue(source);
  if (!normalized) return undefined;

  if (normalized instanceof Map) {
    for (const key of keys) {
      if (normalized.has(key)) return componentPayload(normalized.get(key));
    }
    return undefined;
  }

  if (Array.isArray(normalized)) {
    for (const entry of normalized) {
      const obj = unwrapNbtValue(entry);
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      const entryKey = record.type ?? record.name ?? record.key;
      if (typeof entryKey === "string" && keys.includes(entryKey)) {
        return componentPayload(record);
      }
    }
    return undefined;
  }

  if (typeof normalized === "object") {
    const record = normalized as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] != null) return componentPayload(record[key]);
    }
  }

  return undefined;
}

function componentPayload(value: unknown): unknown {
  const normalized = unwrapNbtValue(value);
  if (!normalized || typeof normalized !== "object") return normalized;
  const record = normalized as Record<string, unknown>;
  if ("data" in record) return unwrapNbtValue(record.data);
  if ("value" in record) return unwrapNbtValue(record.value);
  return normalized;
}

function readItemNbtDisplayField(item: Item, field: "Name" | "Lore"): unknown {
  const obj = item as unknown as { nbt?: unknown };
  const root = unwrapNbtValue(obj.nbt);
  if (!root || typeof root !== "object") return undefined;
  const display = unwrapNbtValue((root as Record<string, unknown>).display);
  if (!display || typeof display !== "object") return undefined;
  return (display as Record<string, unknown>)[field];
}

function unwrapNbtValue(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 6; i += 1) {
    if (!current || typeof current !== "object") return current;
    const obj = current as Record<string, unknown>;
    if (!("value" in obj)) return current;
    current = obj.value;
  }
  return current;
}

function normalizeWindowTitle(title: unknown): string {
  if (typeof title === "string") {
    try {
      return flattenKickComponent(JSON.parse(title)) || title;
    } catch {
      return title || "Window";
    }
  }
  return flattenKickComponent(title) || "Window";
}

const CONFIGURATION_SERVERBOUND_PACKETS = new Set([
  "settings",
  "cookie_response",
  "custom_payload",
  "finish_configuration",
  "keep_alive",
  "pong",
  "resource_pack_receive",
  "select_known_packs",
  "custom_click_action",
  "accept_code_of_conduct",
]);

function withCompleteClientSettings(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return {
    locale: typeof params.locale === "string" ? params.locale : "en_US",
    viewDistance: typeof params.viewDistance === "number" ? params.viewDistance : 12,
    chatFlags: typeof params.chatFlags === "number" ? params.chatFlags : 0,
    chatColors: typeof params.chatColors === "boolean" ? params.chatColors : true,
    skinParts: typeof params.skinParts === "number" ? params.skinParts : 127,
    mainHand: typeof params.mainHand === "number" ? params.mainHand : 1,
    enableTextFiltering:
      typeof params.enableTextFiltering === "boolean"
        ? params.enableTextFiltering
        : false,
    enableServerListing:
      typeof params.enableServerListing === "boolean"
        ? params.enableServerListing
        : true,
    particleStatus:
      typeof params.particleStatus === "string" ? params.particleStatus : "all",
  };
}

function writeClientSettings(
  client: { write(name: string, params: Record<string, unknown>): void },
): void {
  client.write("settings", {});
}

function allowProxyConfigurationRestarts(emitter: EventEmitter): void {
  const currentMax = emitter.getMaxListeners();
  if (currentMax > 0 && currentMax < 50) {
    emitter.setMaxListeners(50);
  }
}

function dedupeProtocolOnceListeners(emitter: EventEmitter, eventNames: string[]): void {
  for (const eventName of eventNames) {
    const onceListeners = emitter.rawListeners(eventName).filter(isOnceWrapper);
    if (onceListeners.length <= 1) continue;
    for (const listener of onceListeners.slice(0, -1)) {
      emitter.off(eventName, listener as (...args: unknown[]) => void);
    }
  }
}

function isOnceWrapper(listener: Function): boolean {
  return typeof (listener as { listener?: unknown }).listener === "function";
}

function normalizeKickReason(reason: unknown): string {
  if (typeof reason === "string") {
    try {
      return flattenKickComponent(JSON.parse(reason)) || reason;
    } catch {
      return reason;
    }
  }
  return flattenKickComponent(reason) || JSON.stringify(reason);
}

function isMicrosoftAuthError(err: Error): boolean {
  const message = err.message.toLowerCase();
  return (
    message.includes("invalid_grant") ||
    message.includes("post_request_failed") ||
    message.includes("expired_token") ||
    message.includes("authorization_declined") ||
    message.includes("failed to obtain profile data") ||
    message.includes("does the account own minecraft")
  );
}

function normalizeRuntimeError(err: Error): string {
  const message = err.message?.trim() || String(err);
  const lower = message.toLowerCase();
  if (lower === "fetch failed" || lower.includes("fetch failed")) {
    return "로그인 서버 연결 실패: 브릿지 서버가 Microsoft/Minecraft 인증 서버에 접속하지 못했습니다.";
  }
  if (lower.includes("client timed out after")) {
    return message;
  }
  if (lower.includes("getaddrinfo")) {
    return "server DNS lookup failed";
  }
  return message;
}

function flattenKickComponent(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);

  const obj = value as {
    text?: unknown;
    extra?: unknown;
    value?: unknown;
    type?: unknown;
  };

  if (obj.type === "string") return flattenKickComponent(obj.value);
  if (obj.type === "compound") return flattenKickComponent(obj.value);

  const parts: string[] = [];
  const text = flattenKickComponent(obj.text);
  if (text) parts.push(text);
  if (Array.isArray(obj.extra)) {
    for (const item of obj.extra) {
      const part = flattenKickComponent(item);
      if (part) parts.push(part);
    }
  }

  if (parts.length > 0) return parts.join("");
  return flattenKickComponent(obj.value);
}
