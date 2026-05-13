import { McSession } from "./mc-session";
import type { BridgeConfig, ServerMessage } from "./types";

interface ManagedSession {
  session: McSession;
  refCount: number;          // how many WS clients are attached
  graceTimer: NodeJS.Timeout | null; // pending shutdown when refCount drops to 0
}

const GRACE_MS = 5 * 1000;

// Tracks one McSession per logged-in user. Multiple WS clients (e.g. an
// iPhone and an iPad) can attach to the same user and share a single bot.
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly cfg: BridgeConfig) {}

  // Get-or-create the session for a given user. If a grace timer was
  // pending it is cancelled.
  attach(
    userId: string,
    cacheUserId: string,
    profilesFolder: string,
    mcVersion: string,
    onMessage: (msg: ServerMessage) => void,
  ): McSession {
    const sessionId = `${userId}@${mcVersion}`;
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      if (this.sessions.size >= this.cfg.maxSessions) {
        throw new Error(
          `bridge full (${this.sessions.size}/${this.cfg.maxSessions} sessions)`,
        );
      }
      const session = new McSession({
        host: this.cfg.mcHost,
        port: this.cfg.mcPort,
        version: mcVersion,
        username: cacheUserId,
        profilesFolder,
      });
      entry = { session, refCount: 0, graceTimer: null };
      this.sessions.set(sessionId, entry);
      session.start();
      session.on("ended", () => {
        // Bot disconnected. Drop the entry so a future attach() rebuilds it.
        const cur = this.sessions.get(sessionId);
        if (cur === entry) this.sessions.delete(sessionId);
      });
    }
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.refCount += 1;

    // Replay history to the newly-attached client.
    for (const m of entry.session.history50()) {
      onMessage(m);
    }
    const status = entry.session.statusSnapshot();
    if (status) onMessage(status);
    entry.session.on("message", onMessage);
    return entry.session;
  }

  detach(sessionId: string, listener: (msg: ServerMessage) => void): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.session.off("message", listener);
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      // Wait briefly before disconnecting the bot in case the user is just
      // losing network for a moment. Keep this short so server-side player
      // counts reflect closed mobile sessions quickly.
      entry.graceTimer = setTimeout(() => {
        entry.session.shutdown("client disconnected");
        this.sessions.delete(sessionId);
      }, GRACE_MS);
    }
  }

  // Force shutdown — used by /logout from the client.
  forceClose(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.session.shutdown("logout");
    this.sessions.delete(sessionId);
  }

  forceCloseUser(userId: string): void {
    for (const [sessionId, entry] of this.sessions) {
      if (!sessionId.startsWith(`${userId}@`)) continue;
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
      entry.session.shutdown("account forgotten");
      this.sessions.delete(sessionId);
    }
  }

  shutdownAll(reason: string): void {
    for (const [, entry] of this.sessions) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      entry.session.shutdown(reason);
    }
    this.sessions.clear();
  }
}
