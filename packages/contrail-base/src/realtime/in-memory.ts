import type { PubSub, RealtimeEvent } from "./types";
import { DEFAULT_QUEUE_BOUND } from "./types";

/** Single-process PubSub backed by in-memory subscriber sets.
 *
 *  Each subscriber owns a bounded queue; when full, oldest events are dropped.
 *  `publish` returns once every subscriber has been offered the event — it
 *  never awaits a subscriber's consumption, so a slow consumer can't block
 *  producers. The cost of that guarantee is the drop-oldest policy. */
export class InMemoryPubSub implements PubSub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly queueBound: number;

  constructor(opts: { queueBound?: number } = {}) {
    this.queueBound = opts.queueBound ?? DEFAULT_QUEUE_BOUND;
  }

  async publish(event: RealtimeEvent): Promise<void> {
    const set = this.subscribers.get(event.topic);
    if (!set) return;
    for (const sub of set) sub.push(event);
  }

  subscribe(topic: string, signal?: AbortSignal): AsyncIterable<RealtimeEvent> {
    const sub = new Subscriber(this.queueBound);
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(sub);

    const cleanup = () => {
      sub.close();
      const s = this.subscribers.get(topic);
      if (s) {
        s.delete(sub);
        if (s.size === 0) this.subscribers.delete(topic);
      }
    };

    if (signal) {
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", cleanup, { once: true });
    }

    return sub.iterate(cleanup);
  }

  /** Test-only: current subscriber count for a topic. */
  subscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }
}

class Subscriber {
  private readonly queue: RealtimeEvent[] = [];
  private pending: ((v: RealtimeEvent | null) => void) | null = null;
  private closed = false;
  /** Number of events dropped because the queue was full. The consumer can
   *  observe a gap by comparing monotonic event timestamps; exposing the
   *  count on a side channel is future work. */
  public droppedCount = 0;

  constructor(private readonly bound: number) {}

  push(event: RealtimeEvent): void {
    if (this.closed) return;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p(event);
      return;
    }
    if (this.queue.length >= this.bound) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p(null);
    }
  }

  iterate(cleanup: () => void): AsyncIterable<RealtimeEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<RealtimeEvent>> {
            if (self.queue.length > 0) {
              return { value: self.queue.shift()!, done: false };
            }
            if (self.closed) return { value: undefined, done: true };
            const event = await new Promise<RealtimeEvent | null>((resolve) => {
              self.pending = resolve;
            });
            if (event === null) return { value: undefined, done: true };
            return { value: event, done: false };
          },
          async return(): Promise<IteratorResult<RealtimeEvent>> {
            cleanup();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
