import { EventEmitter } from "events";
import mineflayer from "mineflayer";
import type { Bot } from "mineflayer";
import { normalizeAuthError } from "./auth";
import type { CompletionMatch, ServerMessage } from "./types";
import { extractSender, plainText, rawJson, richSegments } from "./chat-format";

export interface McSessionOptions {
  host: string;
  port: number;
  version: string;
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
  private lastChatAt = 0;

  // Anti-AFK: nudge the bot every ~3 minutes so the server doesn't kick it.
  private antiAfkTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: McSessionOptions) {
    super();
  }

  start(): void {
    if (this.bot) return;
    const bot = mineflayer.createBot({
      host: this.opts.host,
      port: this.opts.port,
      version: this.opts.version,
      username: this.opts.username,
      auth: "microsoft",
      profilesFolder: this.opts.profilesFolder,
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

  private wireEvents(bot: Bot): void {
    bot.once("spawn", () => {
      const ign = bot.username;
      const uuid = (bot as unknown as { uuid?: string }).uuid ?? "";
      this.emitMsg({ type: "auth_ok", userId: ign, ign, uuid });
      this.markConnected();
      this.startAntiAfk();
    });

    // `messagestr` is mineflayer's "any chat-like message" event including
    // system messages, deaths, joins, leaves. Use the underlying ChatMessage
    // (3rd arg) for sender extraction and JSON.
    bot.on(
      "messagestr",
      (
        text: string,
        _position: string,
        jsonMsg: unknown,
      ) => {
        this.markConnected();
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
      this.emitMsg({
        type: "kicked",
        reason: normalizeKickReason(reason),
      });
    });

    bot.on("end", (reason: string) => {
      this.stopAntiAfk();
      this.connected = false;
      this.emitMsg({
        type: "status",
        connected: false,
        server: `${this.opts.host}:${this.opts.port}`,
      });
      this.emit("ended", reason);
      this.bot = null;
    });

    bot.on("error", (err: Error) => {
      console.error("[mc-session] bot error", err);
      if (isMicrosoftAuthError(err)) {
        this.emitMsg({
          type: "auth_failed",
          reason: normalizeAuthError(err).message,
        });
        return;
      }
      this.emitMsg({ type: "error", text: err.message });
    });
  }

  private wireProtocolCompat(bot: Bot): void {
    const client = bot._client as unknown as {
      on(event: string, listener: (packet: never) => void): void;
      write(name: string, params: Record<string, unknown>): void;
      state?: string;
    };

    client.on("start_configuration", () => {
      this.emitMsg({
        type: "system",
        text: "Server requested configuration restart.",
        ts: Date.now(),
      });
      this.writeConfigurationSettingsWhenReady(client);
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

  // Push a message to listeners and store it in the per-user history ring.
  private emitMsg(msg: ServerMessage): void {
    if (msg.type === "chat" || msg.type === "system") {
      this.history.push(msg);
    }
    this.emit("message", msg);
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
      ign: this.bot.username,
      playersOnline: Object.keys(this.bot.players ?? {}).length,
    };
  }

  shutdown(reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopAntiAfk();
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
      ign: this.bot.username,
      playersOnline: Object.keys(this.bot.players ?? {}).length,
    });
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
    message.includes("authorization_declined")
  );
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
