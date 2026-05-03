/** Merge N AsyncIterables into one, interleaving events as they arrive.
 *  Terminates when every source terminates, or when `signal` aborts. */

export function mergeAsyncIterables<T>(
  sources: AsyncIterable<T>[],
  signal?: AbortSignal
): AsyncIterable<T> {
  if (sources.length === 0) {
    return {
      async *[Symbol.asyncIterator]() {
        /* nothing to yield */
      },
    };
  }

  return {
    [Symbol.asyncIterator]() {
      const iterators = sources.map((s) => s[Symbol.asyncIterator]());
      // One in-flight next() per source, racing each other.
      type Slot = {
        idx: number;
        promise: Promise<{ idx: number; result: IteratorResult<T> }>;
      };
      const pending = new Map<number, Slot>();
      let doneCount = 0;

      const schedule = (idx: number) => {
        const slot: Slot = {
          idx,
          promise: iterators[idx]!
            .next()
            .then((result) => ({ idx, result })),
        };
        pending.set(idx, slot);
      };

      for (let i = 0; i < iterators.length; i++) schedule(i);

      const cleanup = () => {
        for (const it of iterators) {
          try {
            it.return?.();
          } catch {
            /* ignore */
          }
        }
      };

      if (signal) {
        if (signal.aborted) cleanup();
        else signal.addEventListener("abort", cleanup, { once: true });
      }

      return {
        async next(): Promise<IteratorResult<T>> {
          while (pending.size > 0) {
            const slots = [...pending.values()];
            const { idx, result } = await Promise.race(slots.map((s) => s.promise));
            pending.delete(idx);
            if (result.done) {
              doneCount += 1;
              if (doneCount === iterators.length) return { value: undefined, done: true };
              continue;
            }
            schedule(idx);
            return { value: result.value, done: false };
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<T>> {
          cleanup();
          return { value: undefined, done: true };
        },
      };
    },
  };
}
