import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../protocol";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export interface UseBridgeResult {
  state: ConnectionState;
  send: (msg: ClientMessage) => boolean;
  lastError: string | null;
}

// Manages the lifecycle of one WebSocket connection to the bridge. Auto-
// reconnects with exponential backoff while `enabled` is true.
export function useBridge(
  url: string | null,
  enabled: boolean,
  onMessage: (msg: ServerMessage) => void,
): UseBridgeResult {
  const [state, setState] = useState<ConnectionState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!enabled || !url) {
      closedByUs.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      setState("idle");
      return;
    }

    closedByUs.current = false;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setLastError(reason);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectAttempt.current = 0;
        setLastError(null);
        setState("open");
      };
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as ServerMessage;
          onMessageRef.current(parsed);
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onerror = () => {
        setState("error");
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!closedByUs.current) {
          setState("closed");
          scheduleReconnect();
        } else {
          setState("idle");
        }
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectAttempt.current += 1;
      const delay = Math.min(1000 * 2 ** (reconnectAttempt.current - 1), 30_000);
      reconnectTimer.current = setTimeout(connect, delay);
    };

    connect();
    return () => {
      cancelled = true;
      closedByUs.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [url, enabled]);

  const send = useCallback((msg: ClientMessage): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  return { state, send, lastError };
}
