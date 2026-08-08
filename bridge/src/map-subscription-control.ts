const MAP_SUBSCRIBE_LIMIT = 4;
const MAP_SUBSCRIBE_WINDOW_MS = 60_000;

export type MapSubscriptionAdmission =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "capacity" | "rate-limit" };

export class MapSubscriptionGate {
  private readonly activeClients = new Set<string>();
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly maxSubscribers: number) {}

  subscribe(clientId: string, now: number): MapSubscriptionAdmission {
    const recentAttempts = (this.attempts.get(clientId) ?? []).filter(
      (timestamp) => now - timestamp < MAP_SUBSCRIBE_WINDOW_MS,
    );
    if (recentAttempts.length >= MAP_SUBSCRIBE_LIMIT) {
      this.attempts.set(clientId, recentAttempts);
      return { allowed: false, reason: "rate-limit" };
    }
    recentAttempts.push(now);
    this.attempts.set(clientId, recentAttempts);

    if (this.activeClients.has(clientId)) return { allowed: true };
    if (this.activeClients.size >= this.maxSubscribers) {
      return { allowed: false, reason: "capacity" };
    }
    this.activeClients.add(clientId);
    return { allowed: true };
  }

  unsubscribe(clientId: string): void {
    this.activeClients.delete(clientId);
  }

  clear(clientId: string): void {
    this.activeClients.delete(clientId);
    this.attempts.delete(clientId);
  }
}
