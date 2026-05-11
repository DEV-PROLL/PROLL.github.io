// Wire protocol shared with the bridge. Keep in sync with bridge/src/types.ts.

export type ClientMessage =
  | { type: "auth_start"; mcVersion?: string }
  | { type: "auth_cached"; userId: string; mcVersion?: string }
  | { type: "send"; text: string }
  | { type: "complete"; requestId: string; text: string }
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
      fromUuid?: string;
      text: string;
      ts: number;
      segments?: ChatSegment[];
      rawJson?: unknown;
    }
  | { type: "system"; text: string; ts: number; segments?: ChatSegment[]; rawJson?: unknown }
  | {
      type: "completion";
      requestId: string;
      text: string;
      matches: CompletionMatch[];
    }
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
