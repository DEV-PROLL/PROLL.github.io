import { EventEmitter } from "events";
import mineflayer from "mineflayer";
import type { Bot } from "mineflayer";
import type { ServerMessage } from "./types";
import { extractSender, plainText, rawJson } from "./chat-format";

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
  private shuttingDown = false;
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
    this.wireEvents(bot);
  }

  private wireEvents(bot: Bot): void {
    bot.once("spawn", () => {
      const ign = bot.username;
      const uuid = (bot as unknown as { uuid?: string }).uuid ?? "";
      const playersOnline = Object.keys(bot.players ?? {}).length;
      this.emitMsg({ type: "auth_ok", userId: ign, ign, uuid });
      this.emitMsg({
        type: "status",
        connected: true,
        server: `${this.opts.host}:${this.opts.port}`,
        ign,
        playersOnline,
      });
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
        const sender = extractSender(jsonMsg as never);
        if (sender) {
          this.emitMsg({
            type: "chat",
            from: sender,
            text: plainText(jsonMsg as never),
            ts: Date.now(),
            rawJson: rawJson(jsonMsg as never),
          });
        } else {
          this.emitMsg({
            type: "system",
            text,
            ts: Date.now(),
          });
        }
      },
    );

    bot.on("kicked", (reason: string) => {
      this.emitMsg({
        type: "kicked",
        reason: typeof reason === "string" ? reason : JSON.stringify(reason),
      });
    });

    bot.on("end", (reason: string) => {
      this.stopAntiAfk();
      this.emitMsg({
        type: "status",
        connected: false,
        server: `${this.opts.host}:${this.opts.port}`,
      });
      this.emit("ended", reason);
      this.bot = null;
    });

    bot.on("error", (err: Error) => {
      this.emitMsg({ type: "error", text: err.message });
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
    return this.bot != null;
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
}
