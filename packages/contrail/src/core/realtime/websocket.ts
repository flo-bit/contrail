/** WebSocket transport.
 *
 *  Accepts a new WebSocket connection (either via `WebSocketPair` on Workers
 *  or a platform-provided server-side socket) and pumps events to it from an
 *  AsyncIterable<RealtimeEvent>. Messages are UTF-8 JSON, one event per frame.
 *
 *  Close codes (subset, RFC 6455 + app-custom):
 *   - 4001: server error pumping
 *   - 4003: membership revoked
 *   - 4008: ticket/auth invalid (used by the router, not here)
 */

import type { RealtimeEvent } from "./types";
import { DEFAULT_KEEPALIVE_MS } from "./types";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (ev: any) => void): void;
}

export interface WebSocketPumpOptions {
  keepaliveMs?: number;
  onClose?: () => void;
}

/** Pump events from `iter` to `ws` until the signal aborts or the iter ends.
 *  Caller is responsible for having already accept()ed the socket. */
export async function pumpWebSocket(
  ws: WebSocketLike,
  iter: AsyncIterable<RealtimeEvent>,
  signal: AbortSignal,
  opts: WebSocketPumpOptions = {}
): Promise<void> {
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  let closed = false;

  const close = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    opts.onClose?.();
  };

  ws.addEventListener("close", () => {
    closed = true;
    opts.onClose?.();
  });
  ws.addEventListener("error", () => {
    closed = true;
    opts.onClose?.();
  });
  signal.addEventListener("abort", () => close(1000, "aborted"), { once: true });

  const keepalive = setInterval(() => {
    if (closed) return;
    try {
      ws.send(JSON.stringify({ kind: "$keepalive" }));
    } catch {
      close();
    }
  }, keepaliveMs);

  try {
    for await (const event of iter) {
      if (closed) break;
      try {
        ws.send(JSON.stringify(event));
      } catch {
        close(4001, "send-failed");
        break;
      }
    }
  } catch {
    close(4001, "pump-error");
  } finally {
    clearInterval(keepalive);
    close();
  }
}
