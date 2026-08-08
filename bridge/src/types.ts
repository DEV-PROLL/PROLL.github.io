// Wire protocol between mobile app and bridge.
// All messages are JSON over a single WebSocket connection.

import type { MovementControl } from "./movement-control";
import type { CompassDirection } from "./position-direction";

export type { MovementControl } from "./movement-control";

export type ClientMessage =
  | { type: "auth_start"; mcVersion?: string; serverId?: string; loginRequestId?: string }
  | { type: "auth_cached"; userId: string; mcVersion?: string; serverId?: string }
  | { type: "send"; text: string }
  | { type: "complete"; requestId: string; text: string }
  | { type: "window_click"; slot: number; mouseButton?: 0 | 1 }
  | { type: "window_close" }
  | {
      type: "movement_control";
      control: MovementControl;
      pressed: boolean;
      holdMs?: number;
    }
  | { type: "movement_stop_all" }
  | { type: "position_subscribe" }
  | { type: "position_unsubscribe" }
  | { type: "map_subscribe"; radius?: number }
  | { type: "map_unsubscribe" }
  | { type: "forget_account"; userId: string }
  | { type: "logout" }
  | { type: "ping" };

export type ServerMessage =
  | {
      type: "auth_code";
      code: string;
      verificationUri: string;
      expiresInSec: number;
    }
  | { type: "auth_ok"; userId: string; ign: string; uuid: string }
  | { type: "auth_failed"; reason: string }
  | {
      type: "status";
      connected: boolean;
      server: string;
      serverId?: string;
      serverName?: string;
      ign?: string;
      playersOnline?: number;
      reason?: string;
    }
  | {
      type: "chat";
      from: string | null;
      fromUuid?: string;
      text: string;
      ts: number;
      segments?: ChatSegment[];
      rawJson?: unknown;
    }
  | { type: "system"; text: string; ts: number; segments?: ChatSegment[]; rawJson?: unknown }
  | {
      type: "action_bar";
      text: string;
      ts: number;
      segments?: ChatSegment[];
      rawJson?: unknown;
    }
  | {
      type: "title";
      event: "text";
      part: "title" | "subtitle";
      text: string;
      ts: number;
      segments?: ChatSegment[];
      rawJson?: unknown;
    }
  | {
      type: "title";
      event: "times";
      fadeIn: number;
      stay: number;
      fadeOut: number;
      ts: number;
    }
  | { type: "title"; event: "clear"; ts: number }
  | {
      type: "completion";
      requestId: string;
      text: string;
      matches: CompletionMatch[];
    }
  | {
      type: "player_list";
      playersOnline: number;
      players: PlayerSummary[];
      ts: number;
    }
  | {
      type: "boss_bars";
      bars: BossBarSummary[];
      ts: number;
    }
  | {
      type: "player_state";
      health?: number;
      food?: number;
      saturation?: number;
      level?: number;
      xpProgress?: number;
      ts: number;
    }
  | {
      type: "position";
      x: number;
      y: number;
      z: number;
      yaw: number;
      direction: CompassDirection;
      dimension?: string;
      grounded?: boolean;
      ts: number;
    }
  | {
      type: "map_frame";
      centerX: number;
      centerZ: number;
      radius: number;
      step: number;
      dimension: string;
      cols: number;
      rows: number;
      palette: readonly string[];
      cells: string;
      heading: number;
      stale: boolean;
      ts: number;
    }
  | {
      type: "map_state";
      state: "loading" | "live" | "stale" | "unsupported";
      reason?: string;
      ts: number;
    }
  | {
      type: "window_open" | "window_update";
      window: GuiWindow;
    }
  | { type: "window_close"; windowId?: number }
  | { type: "kicked"; reason: string }
  | { type: "error"; text: string }
  | { type: "pong" };

export interface CompletionMatch {
  value: string;
  tooltip?: string;
}

export interface ChatSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  clickEvent?: {
    action: string;
    value: string;
  };
  hoverText?: string;
}

export interface PlayerSummary {
  name: string;
  uuid?: string;
  displayName?: string;
  displayNameSegments?: ChatSegment[];
  ping?: number;
}

export interface BossBarSummary {
  id: string;
  title: string;
  health: number;
  color: string;
  dividers?: number;
}

export interface GuiWindow {
  id: number;
  type: string;
  title: string;
  slotCount: number;
  inventoryStart: number;
  inventoryEnd: number;
  hotbarStart: number;
  slots: GuiSlot[];
  selectedItem?: GuiItem | null;
}

export interface GuiSlot {
  index: number;
  item: GuiItem | null;
}

export interface GuiItem {
  name: string;
  displayName: string;
  displayNameSegments?: ChatSegment[];
  count: number;
  type: number;
  metadata?: number;
  lore?: string[];
  loreSegments?: ChatSegment[][];
  head?: {
    playerUuid?: string;
    playerName?: string;
    textureId?: string;
  };
}

export type HeadProfileBranch =
  | "componentMap"
  | "component"
  | "legacy-nbt"
  | "none";

export type HeadFailureReason =
  | "no-profile"
  | "bad-base64"
  | "non-canonical"
  | "oversize"
  | "bad-json"
  | "bad-scheme"
  | "bad-host"
  | "bad-id";

export interface HeadShapeDiagnostic {
  readonly branch: HeadProfileBranch;
  readonly profileKeys: readonly string[];
  readonly hasUuid: boolean;
  readonly hasName: boolean;
  readonly hasTextures: boolean;
  readonly nameValid: boolean;
  readonly uuidValid: boolean;
  readonly failureReason?: HeadFailureReason;
  readonly textureIdHash8?: string;
}

export interface HeadDiagnostics {
  readonly headsSeen: number;
  readonly headsWithHeadField: number;
  readonly byBranch: Record<HeadProfileBranch, number>;
  readonly byFailureReason: Record<HeadFailureReason, number>;
}

export interface BridgeServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  version: string;
  publicAddress: string;
}

export interface BridgeConfig {
  mcHost: string;
  mcPort: number;
  mcVersion: string;
  serverProfiles: BridgeServerProfile[];
  bindHost: string;
  wsPort: number;
  bridgeToken: string | null;
  tokensDir: string;
  allowedOrigins: string[] | null;
  maxSessions: number;
  chatRateLimit: number;
  sessionGraceMs: number;
  movementAllowedIgns: string[];
  headMetadataEnabled: boolean;
  headDebugEnabled: boolean;
  mapEnabled: boolean;
  mapMaxSubscribers: number;
}
