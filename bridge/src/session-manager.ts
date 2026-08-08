import { McSession } from "./mc-session";
import type {
  MovementDiagnosticEvent,
  MovementEventDiagnostic,
  MovementPositionDelta3s,
} from "./mc-session";
import type { BridgeConfig, BridgeServerProfile, HeadDiagnostics, ServerMessage } from "./types";

interface ManagedSession {
  session: McSession;
  userId: string;
  target: BridgeServerProfile;
  refCount: number;          // how many WS clients are attached
  graceTimer: NodeJS.Timeout | null; // pending shutdown when refCount drops to 0
  graceExpiresAt: number | null;
  createdAt: number;
  lastAttachedAt: number;
}

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
  movementActive: boolean;
  movementClients: number;
  movementControls: string[];
  botControls: Record<string, boolean>;
  physicsEnabled: boolean;
  blockLoaded: boolean;
  gameMode?: string;
  velocity?: { x: number; y: number; z: number };
  movementEpoch: number;
  teleportEpoch: number;
  epochEvents: Record<MovementDiagnosticEvent, MovementEventDiagnostic>;
  lastForcedMoveAt?: number;
  lastPhysicsTickAt?: number;
  loadedColumns: number;
  positionDelta3s?: MovementPositionDelta3s;
  headDiagnostics: HeadDiagnostics;
  position?: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    grounded?: boolean;
  };
  createdAt: number;
  lastAttachedAt: number;
  closing: boolean;
  closesAt?: number;
}

export interface SessionManagerStats {
  active: number;
  movementActive: number;
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
        graceExpiresAt: null,
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
      entry.graceExpiresAt = null;
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
      entry.graceExpiresAt = Date.now() + this.cfg.sessionGraceMs;
      entry.graceTimer = setTimeout(() => {
        entry.session.shutdown("client disconnected");
        this.sessions.delete(sessionId);
      }, this.cfg.sessionGraceMs);
    }
  }

  // Force shutdown — used by /logout from the client.
  forceClose(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
      entry.graceExpiresAt = null;
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
        entry.graceExpiresAt = null;
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
    const sessionEntries = [...this.sessions.entries()];
    return {
      active: this.sessions.size,
      movementActive: sessionEntries.filter(([, entry]) => entry.session.isMovementActive()).length,
      max: this.cfg.maxSessions,
      sessions: sessionEntries.map(([sessionId, entry]) => {
        const session = entry.session.summary();
        const position = entry.session.positionSnapshot();
        const movement = entry.session.movementDiagnostics();
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
          movementActive: entry.session.isMovementActive(),
          movementClients: entry.session.movementClientCount(),
          movementControls: movement.controls,
          botControls: movement.botControls,
          physicsEnabled: movement.physicsEnabled,
          blockLoaded: movement.blockLoaded,
          gameMode: movement.gameMode,
          velocity: movement.velocity,
          movementEpoch: movement.movementEpoch,
          teleportEpoch: movement.teleportEpoch,
          epochEvents: movement.epochEvents,
          lastForcedMoveAt: movement.lastForcedMoveAt,
          lastPhysicsTickAt: movement.lastPhysicsTickAt,
          loadedColumns: movement.loadedColumns,
          positionDelta3s: movement.positionDelta3s,
          headDiagnostics: entry.session.headDiagnostics(),
          position: position
            ? {
                x: position.x,
                y: position.y,
                z: position.z,
                yaw: position.yaw,
                grounded: position.grounded,
              }
            : undefined,
          createdAt: entry.createdAt,
          lastAttachedAt: entry.lastAttachedAt,
          closing: Boolean(entry.graceTimer),
          closesAt: entry.graceExpiresAt ?? undefined,
        };
      }),
    };
  }
}

function buildSessionId(userId: string, target: BridgeServerProfile): string {
  return `${encodeURIComponent(userId)}@${target.id}@${target.version}`;
}
