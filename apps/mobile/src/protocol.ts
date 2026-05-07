// Wire protocol shared with the bridge. Keep in sync with bridge/src/types.ts.

export type ClientMessage =
  | { type: "auth_start" }
  | { type: "auth_cached"; userId: string }
  | { type: "send"; text: string }
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
      ign?: string;
      playersOnline?: number;
    }
  | {
      type: "chat";
      from: string | null;
      text: string;
      ts: number;
      rawJson?: unknown;
    }
  | { type: "system"; text: string; ts: number }
  | { type: "kicked"; reason: string }
  | { type: "error"; text: string }
  | { type: "pong" };
