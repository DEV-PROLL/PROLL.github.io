import type {
  ClientMessage,
  MovementControl,
} from "./protocol";

const MOVEMENT_HOLD_MS = 1_500;
const MOVEMENT_HEARTBEAT_MS = 500;

interface MovementPanelSessionIO {
  send: (message: ClientMessage) => boolean;
  setActiveControls: (controls: ReadonlySet<MovementControl>) => void;
  clearPosition: () => void;
  clearMap: () => void;
  mapEnabled: boolean;
  startHeartbeat: (callback: () => void) => unknown;
  stopHeartbeat: (timer: unknown) => void;
}

interface MovementControlPressHandlers {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
}

export class MovementPanelSession {
  private readonly io: MovementPanelSessionIO;
  private readonly controls = new Set<MovementControl>();
  private readonly heartbeats = new Map<MovementControl, unknown>();
  private available = false;
  private active = false;
  private subscribed = false;
  private mapSubscribed = false;
  private disposed = false;

  constructor(io: MovementPanelSessionIO) {
    this.io = io;
  }

  setAvailable(available: boolean): void {
    if (this.disposed || available === this.available) return;
    this.available = available;
    if (available) {
      this.resume();
      return;
    }
    this.suspend();
  }

  resume(): void {
    if (this.disposed || !this.available || this.active) return;
    this.active = true;
    this.subscribed = this.io.send({ type: "position_subscribe" });
    if (this.io.mapEnabled) {
      this.mapSubscribed = this.io.send({ type: "map_subscribe" });
    }
  }

  suspend(): void {
    this.deactivate(true);
  }

  press(control: MovementControl): void {
    if (
      this.disposed ||
      !this.available ||
      !this.active ||
      this.controls.has(control)
    ) {
      return;
    }
    const command: ClientMessage = {
      type: "movement_control",
      control,
      pressed: true,
      holdMs: MOVEMENT_HOLD_MS,
    };
    if (!this.io.send(command)) return;
    this.controls.add(control);
    this.publishControls();
    this.heartbeats.set(
      control,
      this.io.startHeartbeat(() => {
        if (this.io.send(command)) return;
        this.clearControl(control);
      }),
    );
  }

  release(control: MovementControl): void {
    if (!this.controls.has(control)) return;
    this.clearControl(control);
    this.io.send({
      type: "movement_control",
      control,
      pressed: false,
    });
  }

  stopAll(): void {
    if (this.disposed || !this.active) return;
    this.clearControls();
    this.io.send({ type: "movement_stop_all" });
  }

  activeControls(): MovementControl[] {
    return [...this.controls];
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivate(false);
    this.disposed = true;
  }

  private deactivate(notify: boolean): void {
    if (!this.active) return;
    this.active = false;
    this.clearControls(notify);
    this.io.send({ type: "movement_stop_all" });
    if (this.subscribed) {
      this.io.send({ type: "position_unsubscribe" });
      this.subscribed = false;
    }
    if (this.mapSubscribed) {
      this.io.send({ type: "map_unsubscribe" });
      this.mapSubscribed = false;
    }
    if (notify) {
      this.io.clearPosition();
      this.io.clearMap();
    }
  }

  private clearControl(control: MovementControl): void {
    const heartbeat = this.heartbeats.get(control);
    if (heartbeat !== undefined) this.io.stopHeartbeat(heartbeat);
    this.heartbeats.delete(control);
    if (!this.controls.delete(control)) return;
    this.publishControls();
  }

  private clearControls(notify = true): void {
    for (const heartbeat of this.heartbeats.values()) {
      this.io.stopHeartbeat(heartbeat);
    }
    this.heartbeats.clear();
    if (this.controls.size === 0) return;
    this.controls.clear();
    if (notify) this.publishControls();
  }

  private publishControls(): void {
    this.io.setActiveControls(new Set(this.controls));
  }
}

export function movementControlPressHandlers(
  session: MovementPanelSession,
  control: MovementControl,
): MovementControlPressHandlers {
  return {
    onPointerDown: () => session.press(control),
    onPointerUp: () => session.release(control),
    onPointerCancel: () => session.release(control),
    onPointerLeave: () => session.release(control),
  };
}
