import { EventEmitter } from "events";
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

type PlayerListMessage = Extract<ServerMessage, { type: "player_list" }>;
type BossBarsMessage = Extract<ServerMessage, { type: "boss_bars" }>;
type PlayerStateMessage = Extract<ServerMessage, { type: "player_state" }>;
type PositionMessage = Extract<ServerMessage, { type: "position" }>;
type SerializedLoreLine = { text: string; segments?: ChatSegment[] };

const DEBUG_GUI_ITEMS = process.env.DEBUG_GUI_ITEMS === "1";
const POSITION_SYNC_MS = 250;
const debuggedGuiItems = new Set<string>();

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
  private lastPositionSignature = "";
  private readonly suppressedBossBarIds = new Set<string>();
  private readonly movementLeases = new MovementLeaseBook();
  private positionTimer: NodeJS.Timeout | null = null;
  private movementWatchdogTimer: NodeJS.Timeout | null = null;

  // Anti-AFK: nudge the bot every ~3 minutes so the server doesn't kick it.
  private antiAfkTimer: NodeJS.Timeout | null = null;
  private configurationRestartTimer: NodeJS.Timeout | null = null;
  private packetActivityTimer: NodeJS.Timeout | null = null;
  private lastInboundPacketAt = 0;

  constructor(private readonly opts: McSessionOptions) {
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
      const active = this.movementLeases.activeControls();
      if (active.size > 0) this.writeMovementInput(bot, active);
    });

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
      this.movementLeases.press(clientId, control, holdMs, Date.now());
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

  movementDiagnostics(): {
    controls: MovementControl[];
    botControls: Record<MovementControl, boolean>;
    physicsEnabled: boolean;
    blockLoaded: boolean;
    gameMode?: string;
    velocity?: { x: number; y: number; z: number };
  } {
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
      window: serializeWindow(window),
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
    this.stopPositionSync();
    this.clearConfigurationRestartWatchdog();
    this.stopPacketActivityWatchdog();
    this.detachGuiWindow();
    this.stopPlayerListSync();
    this.lastBossBarsSignature = "";
    this.lastPlayerStateSignature = "";
    this.lastPositionSignature = "";
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
    this.stopPositionSync();
    this.clearConfigurationRestartWatchdog();
    this.stopPacketActivityWatchdog();
    this.detachGuiWindow();
    this.stopPlayerListSync();
    this.lastBossBarsSignature = "";
    this.lastPlayerStateSignature = "";
    this.lastPositionSignature = "";
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
      ts: Date.now(),
    };
  }

  private startPositionSync(): void {
    this.stopPositionSync();
    this.positionTimer = setInterval(() => this.emitPosition(), POSITION_SYNC_MS);
  }

  private stopPositionSync(): void {
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = null;
    this.lastPositionSignature = "";
  }

  private emitPosition(force = false): void {
    const msg = this.positionSnapshot();
    if (!msg) return;
    const signature = [
      msg.x.toFixed(3),
      msg.y.toFixed(3),
      msg.z.toFixed(3),
      msg.yaw.toFixed(1),
      msg.dimension ?? "",
      msg.grounded ?? "",
    ].join(":");
    if (!force && signature === this.lastPositionSignature) return;
    this.lastPositionSignature = signature;
    this.emitMsg(msg);
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
      if (this.movementLeases.expire(Date.now())) {
        this.syncMovementControls();
      }
      this.armMovementWatchdog();
    }, Math.max(0, expiresAt - Date.now()));
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

function serializeWindow(window: Window): GuiWindow {
  return {
    id: window.id,
    type: String(window.type),
    title: normalizeWindowTitle(window.title),
    slotCount: window.slots.length,
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    hotbarStart: window.hotbarStart,
    selectedItem: serializeItem(window.selectedItem),
    slots: window.slots.map((item, index) => ({
      index,
      item: serializeItem(item),
    })),
  };
}

function serializeItem(item: Item | null | undefined): GuiItem | null {
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
  };
}

function debugGuiItem(item: Item, displayName: string, lore: string[]): void {
  if (!DEBUG_GUI_ITEMS) return;
  const summary = summarizeItemForDebug(item, displayName, lore);
  const key = JSON.stringify(summary);
  if (debuggedGuiItems.has(key) || debuggedGuiItems.size >= 40) return;
  debuggedGuiItems.add(key);
  console.log(`[bridge] gui_item ${key}`);
}

function summarizeItemForDebug(
  item: Item,
  displayName: string,
  lore: string[],
): Record<string, unknown> {
  const obj = item as unknown as Record<string, unknown>;
  return {
    name: item.name,
    displayName,
    lore,
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

function summarizeValue(value: unknown, depth = 0): unknown {
  const normalized = unwrapNbtValue(value);
  if (normalized == null) return normalized;
  if (typeof normalized === "string") {
    return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
  }
  if (
    typeof normalized === "number" ||
    typeof normalized === "boolean"
  ) {
    return normalized;
  }
  if (depth >= 6) return "[Object]";
  if (normalized instanceof Map) {
    const entries: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entryValue] of normalized.entries()) {
      if (count >= 12) break;
      entries[String(key)] = summarizeValue(entryValue, depth + 1);
      count += 1;
    }
    return entries;
  }
  if (Array.isArray(normalized)) {
    return normalized.slice(0, 12).map((entry) => summarizeValue(entry, depth + 1));
  }
  if (typeof normalized === "object") {
    const record = normalized as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).slice(0, 16)) {
      out[key] = summarizeValue(record[key], depth + 1);
    }
    return out;
  }
  return String(normalized);
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
