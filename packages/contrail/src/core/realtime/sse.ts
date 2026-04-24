/** Server-Sent Events transport.
 *
 *  Wraps an AsyncIterable<RealtimeEvent> as a streaming Response. The caller
 *  (the router) has already done auth and has an AbortSignal it can use to
 *  tear the stream down (e.g. on `member.removed` for the subscriber's DID). */

import type { RealtimeEvent } from "./types";
import { DEFAULT_KEEPALIVE_MS } from "./types";

export interface SseOptions {
  keepaliveMs?: number;
  /** Called before the stream closes. Useful for cleanup that the caller
   *  can't do via the signal (e.g. removing a subscriber from a set). */
  onClose?: () => void;
}

export function sseResponse(
  iter: AsyncIterable<RealtimeEvent>,
  signal: AbortSignal,
  opts: SseOptions = {}
): Response {
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        opts.onClose?.();
      };

      signal.addEventListener("abort", close, { once: true });

      keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          close();
        }
      }, keepaliveMs);

      (async () => {
        // Opening comment — helps some clients / proxies initialize promptly.
        controller.enqueue(encoder.encode(`: open\n\n`));
        try {
          for await (const event of iter) {
            if (closed) break;
            controller.enqueue(encoder.encode(frameEvent(event)));
          }
        } catch (err) {
          if (!closed) {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({
                    message: err instanceof Error ? err.message : String(err),
                  })}\n\n`
                )
              );
            } catch {
              /* stream already torn down */
            }
          }
        } finally {
          close();
        }
      })();
    },
    cancel() {
      opts.onClose?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function frameEvent(event: RealtimeEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}
