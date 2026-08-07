export const MOVEMENT_CONTROLS = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sneak",
] as const;

export type MovementControl = (typeof MOVEMENT_CONTROLS)[number];

export const MOVEMENT_HOLD_MIN_MS = 250;
export const MOVEMENT_HOLD_DEFAULT_MS = 1_250;
export const MOVEMENT_HOLD_MAX_MS = 2_000;
export const MOVEMENT_RATE_LIMIT = 24;
export const MOVEMENT_RATE_WINDOW_MS = 1_000;

interface MovementControlCommand {
  control: MovementControl;
  pressed: boolean;
  holdMs: number;
}

export type MovementControlParseResult =
  | { ok: true; value: MovementControlCommand }
  | { ok: false; reason: string };

export class MovementLeaseBook {
  private readonly clients = new Map<string, Map<MovementControl, number>>();

  press(
    clientId: string,
    control: MovementControl,
    holdMs: number,
    now: number,
  ): boolean {
    const controls = this.clients.get(clientId) ?? new Map<MovementControl, number>();
    const expiresAt =
      now + Math.max(MOVEMENT_HOLD_MIN_MS, Math.min(MOVEMENT_HOLD_MAX_MS, holdMs));
    const changed = !controls.has(control);
    controls.set(control, expiresAt);
    this.clients.set(clientId, controls);
    return changed;
  }

  release(clientId: string, control: MovementControl): boolean {
    const controls = this.clients.get(clientId);
    if (!controls?.delete(control)) return false;
    if (controls.size === 0) this.clients.delete(clientId);
    return true;
  }

  stopClient(clientId: string): boolean {
    return this.clients.delete(clientId);
  }

  stopAll(): boolean {
    if (this.clients.size === 0) return false;
    this.clients.clear();
    return true;
  }

  expire(now: number): boolean {
    let changed = false;
    for (const [clientId, controls] of this.clients) {
      for (const [control, expiresAt] of controls) {
        if (expiresAt > now) continue;
        controls.delete(control);
        changed = true;
      }
      if (controls.size === 0) this.clients.delete(clientId);
    }
    return changed;
  }

  activeControls(): ReadonlySet<MovementControl> {
    const active = new Set<MovementControl>();
    for (const control of MOVEMENT_CONTROLS) {
      for (const controls of this.clients.values()) {
        if (!controls.has(control)) continue;
        active.add(control);
        break;
      }
    }
    return active;
  }

  activeClientCount(): number {
    return this.clients.size;
  }

  isActive(): boolean {
    return this.clients.size > 0;
  }

  nextExpiryAt(): number | null {
    let earliest: number | null = null;
    for (const controls of this.clients.values()) {
      for (const expiresAt of controls.values()) {
        if (earliest == null || expiresAt < earliest) earliest = expiresAt;
      }
    }
    return earliest;
  }
}

export class MovementRateGate {
  private readonly clients = new Map<string, { resetAt: number; count: number }>();

  allow(clientId: string, now: number): boolean {
    const bucket = this.clients.get(clientId);
    if (!bucket || now < bucket.resetAt - MOVEMENT_RATE_WINDOW_MS || now >= bucket.resetAt) {
      this.clients.set(clientId, {
        resetAt: now + MOVEMENT_RATE_WINDOW_MS,
        count: 1,
      });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= MOVEMENT_RATE_LIMIT;
  }

  clear(clientId: string): void {
    this.clients.delete(clientId);
  }
}

const MOVEMENT_CONTROL_SET: ReadonlySet<string> = new Set(MOVEMENT_CONTROLS);

export function parseMovementControlMessage(value: unknown): MovementControlParseResult {
  if (!isObject(value) || value.type !== "movement_control") {
    return { ok: false, reason: "invalid movement command" };
  }
  const { control, pressed, holdMs } = value;
  if (!isMovementControl(control)) {
    return { ok: false, reason: "invalid movement control" };
  }
  if (typeof pressed !== "boolean") {
    return { ok: false, reason: "invalid movement state" };
  }
  if (
    holdMs !== undefined &&
    (typeof holdMs !== "number" ||
      !Number.isInteger(holdMs) ||
      holdMs < MOVEMENT_HOLD_MIN_MS ||
      holdMs > MOVEMENT_HOLD_MAX_MS)
  ) {
    return { ok: false, reason: "invalid movement hold duration" };
  }
  return {
    ok: true,
    value: {
      control,
      pressed,
      holdMs: pressed ? holdMs ?? MOVEMENT_HOLD_DEFAULT_MS : 0,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isMovementControl(value: unknown): value is MovementControl {
  return typeof value === "string" && MOVEMENT_CONTROL_SET.has(value);
}
