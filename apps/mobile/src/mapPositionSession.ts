import type { ClientMessage } from "./protocol";

interface MapPositionSessionIO {
  send: (message: ClientMessage) => boolean;
  clearPosition: () => void;
  clearMap: () => void;
  mapEnabled: boolean;
}

export class MapPositionSession {
  private readonly io: MapPositionSessionIO;
  private available = false;
  private active = false;
  private positionSubscribed = false;
  private mapSubscribed = false;
  private disposed = false;

  constructor(io: MapPositionSessionIO) {
    this.io = io;
  }

  setAvailable(available: boolean): void {
    if (this.disposed || available === this.available) return;
    this.available = available;
    if (available) this.resume();
    else this.suspend();
  }

  resume(): void {
    if (this.disposed || !this.available || this.active) return;
    this.active = true;
    this.positionSubscribed = this.io.send({ type: "position_subscribe" });
    if (this.io.mapEnabled) {
      this.mapSubscribed = this.io.send({ type: "map_subscribe" });
    }
  }

  suspend(): void {
    this.deactivate(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivate(false);
    this.disposed = true;
  }

  private deactivate(clear: boolean): void {
    if (!this.active) return;
    this.active = false;
    if (this.positionSubscribed) {
      this.io.send({ type: "position_unsubscribe" });
      this.positionSubscribed = false;
    }
    if (this.mapSubscribed) {
      this.io.send({ type: "map_unsubscribe" });
      this.mapSubscribed = false;
    }
    if (clear) {
      this.io.clearPosition();
      this.io.clearMap();
    }
  }
}
