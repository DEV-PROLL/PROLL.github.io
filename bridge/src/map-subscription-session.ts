import type { ServerMessage } from "./types";

const MAP_FRAME_INTERVAL_MS = 2_000;
const MAP_UNSUPPORTED_AFTER_MS = 5_000;
const MAP_HEADING_STEP_DEGREES = 5;

type MapFrameMessage = Extract<ServerMessage, { type: "map_frame" }>;
type MapStateMessage = Extract<ServerMessage, { type: "map_state" }>;

export interface MapSourceSnapshot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly dimension: string;
}

export interface MapSampleResult {
  readonly frame: MapFrameMessage;
  readonly loadedColumns: number;
}

interface MapSubscriptionSessionIO {
  readonly now: () => number;
  readonly snapshot: () => MapSourceSnapshot | null;
  readonly sample: (
    snapshot: MapSourceSnapshot,
    radius: number | undefined,
    signal: AbortSignal,
  ) => Promise<MapSampleResult>;
  readonly startPolling: (
    callback: () => Promise<void>,
    intervalMs: number,
  ) => unknown;
  readonly stopPolling: (timer: unknown) => void;
}

interface MapSubscription {
  readonly listener: (message: MapFrameMessage | MapStateMessage) => void;
  readonly radius: number | undefined;
  readonly startedAt: number;
  lastSignature: string;
  lastStateSignature: string;
  hasFrame: boolean;
  controller: AbortController | null;
}

export class MapSubscriptionSession {
  private readonly subscriptions = new Map<string, MapSubscription>();
  private pollingTimer: unknown = null;
  private dirtyRevision = 0;
  private suspended = false;

  constructor(private readonly io: MapSubscriptionSessionIO) {}

  start(
    clientId: string,
    listener: MapSubscription["listener"],
    radius?: number,
  ): void {
    this.stop(clientId);
    const subscription: MapSubscription = {
      listener,
      radius,
      startedAt: this.io.now(),
      lastSignature: "",
      lastStateSignature: "",
      hasFrame: false,
      controller: null,
    };
    this.subscriptions.set(clientId, subscription);
    this.emitState(clientId, subscription, "loading");
    this.startPolling();
    void this.sample(clientId, subscription, true);
  }

  stop(clientId: string): void {
    const subscription = this.subscriptions.get(clientId);
    if (!subscription) return;
    subscription.controller?.abort();
    this.subscriptions.delete(clientId);
    if (this.subscriptions.size === 0) this.stopPolling();
  }

  clear(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.controller?.abort();
    }
    this.subscriptions.clear();
    this.stopPolling();
  }

  markDirty(): void {
    this.dirtyRevision += 1;
  }

  suspend(reason: string): void {
    if (this.suspended) return;
    this.suspended = true;
    for (const [clientId, subscription] of this.subscriptions) {
      subscription.controller?.abort();
      subscription.controller = null;
      subscription.lastSignature = "";
      this.emitState(clientId, subscription, "stale", reason);
    }
  }

  resume(): void {
    this.suspended = false;
  }

  subscriberCount(): number {
    return this.subscriptions.size;
  }

  private startPolling(): void {
    if (this.pollingTimer !== null || this.subscriptions.size === 0) return;
    this.pollingTimer = this.io.startPolling(
      () => this.poll(),
      MAP_FRAME_INTERVAL_MS,
    );
  }

  private stopPolling(): void {
    if (this.pollingTimer !== null) this.io.stopPolling(this.pollingTimer);
    this.pollingTimer = null;
  }

  private async poll(): Promise<void> {
    if (this.suspended) return;
    const now = this.io.now();
    for (const [clientId, subscription] of this.subscriptions) {
      if (
        !subscription.hasFrame &&
        now - subscription.startedAt >= MAP_UNSUPPORTED_AFTER_MS
      ) {
        this.emitState(
          clientId,
          subscription,
          "unsupported",
          "no-loaded-chunks",
        );
      }
      await this.sample(clientId, subscription, false);
    }
  }

  private async sample(
    clientId: string,
    subscription: MapSubscription,
    force: boolean,
  ): Promise<void> {
    if (this.suspended || subscription.controller) return;
    const snapshot = this.io.snapshot();
    if (!snapshot) return;
    const signature = this.snapshotSignature(snapshot);
    if (!force && signature === subscription.lastSignature) return;
    subscription.lastSignature = signature;
    const controller = new AbortController();
    subscription.controller = controller;
    try {
      const result = await this.io.sample(
        snapshot,
        subscription.radius,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        this.subscriptions.get(clientId) !== subscription
      ) {
        return;
      }
      if (result.loadedColumns === 0) {
        subscription.lastSignature = "";
        if (
          this.io.now() - subscription.startedAt >=
          MAP_UNSUPPORTED_AFTER_MS
        ) {
          this.emitState(
            clientId,
            subscription,
            "unsupported",
            "no-loaded-chunks",
          );
        }
        return;
      }
      this.emitState(clientId, subscription, "live");
      this.deliver(clientId, subscription, result.frame);
      subscription.hasFrame = true;
    } catch (error) {
      if (controller.signal.aborted) return;
      subscription.lastSignature = "";
      this.emitState(
        clientId,
        subscription,
        "unsupported",
        error instanceof Error ? error.name : "sampling",
      );
    } finally {
      if (subscription.controller === controller) {
        subscription.controller = null;
      }
    }
  }

  private snapshotSignature(snapshot: MapSourceSnapshot): string {
    const heading =
      ((Math.floor(snapshot.heading) % 360) + 360) % 360;
    return [
      Math.floor(snapshot.x),
      Math.floor(snapshot.y),
      Math.floor(snapshot.z),
      Math.floor(heading / MAP_HEADING_STEP_DEGREES),
      snapshot.dimension,
      this.dirtyRevision,
    ].join(":");
  }

  private emitState(
    clientId: string,
    subscription: MapSubscription,
    state: MapStateMessage["state"],
    reason?: string,
  ): void {
    const signature = `${state}:${reason ?? ""}`;
    if (signature === subscription.lastStateSignature) return;
    subscription.lastStateSignature = signature;
    this.deliver(clientId, subscription, {
      type: "map_state",
      state,
      reason,
      ts: this.io.now(),
    });
  }

  private deliver(
    clientId: string,
    subscription: MapSubscription,
    message: MapFrameMessage | MapStateMessage,
  ): void {
    try {
      subscription.listener(message);
    } catch {
      this.stop(clientId);
    }
  }
}
