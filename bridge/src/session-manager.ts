import { McSession } from "./mc-session";
import type { BridgeConfig, BridgeServerProfile, ServerMessage } from "./types";

interface ManagedSession {
  session: McSession;
  userId: string;
  target: BridgeServerProfile;
  refCount: number;          // how many WS clients are attached
  graceTimer: NodeJS.Timeout | null; // pending shutdown when refCount drops to 0
  createdAt: number;
  lastAttachedAt: number;
}

const GRACE_MS = 5 * 1000;

export interface ManagedSessionSummary {
  sessionId: string;
  userId: string;
  serverId: string;
  serverName: string;
  serverAddress: string;
  mcVersion: string;
  refCount: number;
  connected: boolean;
  ign?: string;
  playersOnline?: number;
  createdAt: number;
  lastAttachedAt: number;
  closing: boolean;
}

export interface SessionManagerStats {
  active: number;
  max: number;
  sessions: ManagedSessionSummary[];
}

export interface SessionAttachResult {
  sessionId: string;
  session: McSession;
  created: boolean;
  resumedFromGrace: boolean;
  refCount: number;
}

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
    target: BridgeServerProfile,
    onMessage: (msg: ServerMessage) => void,
  ): SessionAttachResult {
    const sessionId = buildSessionId(userId, target);
    let entry = this.sessions.get(sessionId);
    let created = false;
    if (!entry) {
      if (this.sessions.size >= this.cfg.maxSessions) {
        throw new Error(
          `bridge full (${this.sessions.size}/${this.cfg.maxSessions} sessions)`,
        );
      }
      const session = new McSession({
        host: target.host,
        port: target.port,
        version: target.version,
        serverId: target.id,
        serverName: target.name,
        username: cacheUserId,
        profilesFolder,
      });
      const now = Date.now();
      entry = {
        session,
        userId,
        target,
        refCount: 0,
        graceTimer: null,
        createdAt: now,
        lastAttachedAt: now,
      };
      this.sessions.set(sessionId, entry);
      created = true;
      session.start();
      session.on("ended", () => {
        // Bot disconnected. Drop the entry so a future attach() rebuilds it.
        const cur = this.sessions.get(sessionId);
        if (cur === entry) this.sessions.delete(sessionId);
      });
    }
    const resumedFromGrace = Boolean(entry.graceTimer);
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.refCount += 1;
    entry.lastAttachedAt = Date.now();

    // Replay history to the newly-attached client.
    for (const m of entry.session.history50()) {
      onMessage(m);
    }
    const status = entry.session.statusSnapshot();
    if (status) onMessage(status);
    const playerList = entry.session.playerListSnapshot();
    if (playerList) onMessage(playerList);
    const bossBars = entry.session.bossBarsSnapshot();
    if (bossBars) onMessage(bossBars);
    const playerState = entry.session.playerStateSnapshot();
    if (playerState) onMessage(playerState);
    entry.session.on("message", onMessage);
    return {
      sessionId,
      session: entry.session,
      created,
      resumedFromGrace,
      refCount: entry.refCount,
    };
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
      if (entry.userId !== userId) continue;
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

  stats(): SessionManagerStats {
    return {
      active: this.sessions.size,
      max: this.cfg.maxSessions,
      sessions: [...this.sessions.entries()].map(([sessionId, entry]) => {
        const session = entry.session.summary();
        return {
          sessionId,
          userId: entry.userId,
          serverId: entry.target.id,
          serverName: entry.target.name,
          serverAddress: entry.target.publicAddress,
          mcVersion: entry.target.version,
          refCount: entry.refCount,
          connected: session.connected,
          ign: session.ign,
          playersOnline: session.playersOnline,
          createdAt: entry.createdAt,
          lastAttachedAt: entry.lastAttachedAt,
          closing: Boolean(entry.graceTimer),
        };
      }),
    };
  }
}

function buildSessionId(userId: string, target: BridgeServerProfile): string {
  return `${encodeURIComponent(userId)}@${target.id}@${target.version}`;
}
