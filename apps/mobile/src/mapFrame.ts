import type { MapFrame, MapStateMessage } from "./protocol";

const MAP_MAX_SIDE = 65;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface MapViewState {
  readonly state: MapStateMessage["state"];
  readonly reason: string | undefined;
  readonly frame: MapFrame | null;
  readonly ts: number;
}

export const EMPTY_MAP_VIEW: MapViewState = {
  state: "loading",
  reason: undefined,
  frame: null,
  ts: 0,
};

export function applyMapMessage(
  current: MapViewState,
  message: MapFrame | MapStateMessage,
): MapViewState {
  switch (message.type) {
    case "map_frame":
      return {
        state: message.stale ? "stale" : "live",
        reason: undefined,
        frame: message,
        ts: message.ts,
      };
    case "map_state":
      switch (message.state) {
        case "loading":
          return {
            state: "loading",
            reason: message.reason,
            frame: null,
            ts: message.ts,
          };
        case "live":
          return {
            state: "live",
            reason: message.reason,
            frame: current.frame,
            ts: message.ts,
          };
        case "stale":
          return {
            state: "stale",
            reason: message.reason,
            frame: current.frame,
            ts: message.ts,
          };
        case "unsupported":
          return {
            state: "unsupported",
            reason: message.reason,
            frame: null,
            ts: message.ts,
          };
      }
  }
}

export function decodeMapCells(frame: MapFrame): Uint8Array {
  if (
    !Number.isInteger(frame.cols) ||
    !Number.isInteger(frame.rows) ||
    frame.cols < 1 ||
    frame.rows < 1 ||
    frame.cols > MAP_MAX_SIDE ||
    frame.rows > MAP_MAX_SIDE
  ) {
    throw new Error("invalid map dimensions");
  }
  const binary = globalThis.atob(frame.cells);
  const cells = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (cells.length !== frame.cols * frame.rows) {
    throw new Error("invalid map cell count");
  }
  return cells;
}

export function mapFrameRgba(frame: MapFrame): Uint8ClampedArray {
  const cells = decodeMapCells(frame);
  const colors = frame.palette.map(parseHexColor);
  const rgba = new Uint8ClampedArray(cells.length * 4);
  cells.forEach((paletteIndex, index) => {
    const color = colors[paletteIndex];
    if (!color) throw new Error("invalid map palette index");
    const offset = index * 4;
    rgba[offset] = color.red;
    rgba[offset + 1] = color.green;
    rgba[offset + 2] = color.blue;
    rgba[offset + 3] = 255;
  });
  return rgba;
}

function parseHexColor(value: string): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} {
  if (!HEX_COLOR.test(value)) throw new Error("invalid map palette color");
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}
