/** Internal fair-work scheduling shared by legacy and generation PDS crawlers. */

/** Keep a fixed number of jobs active without batch barriers. Returning true
 * from consume requeues only that item, allowing paginated work to yield fairly. */
export async function drainQueue<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  run: (item: TItem) => Promise<TResult>,
  consume: (result: TResult) => boolean | void,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  let nextIndex = 0;
  let active = 0;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (settled) return;
      while (active < concurrency && nextIndex < queue.length) {
        const item = queue[nextIndex++];
        active++;
        run(item).then(
          (result) => {
            active--;
            if (consume(result) === true) queue.push(item);
            if (active === 0 && nextIndex >= queue.length) {
              settled = true;
              resolve();
            } else {
              pump();
            }
          },
          (error) => {
            settled = true;
            reject(error);
          },
        );
      }
    };
    pump();
  });
}

export function createStreamingHostScheduler<TResult>(
  hostConcurrency: number,
  didsPerHost: number,
  run: (pds: string, did: string) => Promise<TResult>,
  consume: (result: TResult) =>
    | boolean
    | void
    | Promise<boolean | void>,
): {
  add(pds: string, did: string): void;
  finish(): Promise<void>;
} {
  type HostState = {
    pending: string[];
    active: number;
    queued: boolean;
    running: boolean;
  };
  const hosts = new Map<string, HostState>();
  const waiting: string[] = [];
  let activeHosts = 0;
  let producerDone = false;
  let settled = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectFinished(error);
  };

  const maybeFinish = () => {
    if (settled || !producerDone) return;
    if (activeHosts === 0 && waiting.length === 0) {
      settled = true;
      resolveFinished();
    }
  };

  const pumpHosts = () => {
    if (settled) return;
    while (activeHosts < hostConcurrency && waiting.length > 0) {
      const pds = waiting.shift()!;
      const state = hosts.get(pds)!;
      state.queued = false;
      if (state.running || state.pending.length === 0) continue;
      state.running = true;
      activeHosts++;
      pumpDids(pds, state);
    }
    maybeFinish();
  };

  const finishHost = (state: HostState) => {
    if (!state.running) return;
    state.running = false;
    activeHosts--;
    pumpHosts();
  };

  function pumpDids(pds: string, state: HostState): void {
    if (settled) return;
    while (state.active < didsPerHost && state.pending.length > 0) {
      const did = state.pending.shift()!;
      state.active++;
      run(pds, did)
        .then(async (result) => {
          const requeue = await consume(result);
          state.active--;
          if (requeue === true) state.pending.push(did);
          pumpDids(pds, state);
        })
        .catch(fail);
    }
    if (state.active === 0 && state.pending.length === 0) {
      finishHost(state);
    }
  }

  return {
    add(pds, did) {
      if (producerDone) throw new Error("Cannot add work after scheduler finish");
      let state = hosts.get(pds);
      if (!state) {
        state = { pending: [], active: 0, queued: false, running: false };
        hosts.set(pds, state);
      }
      state.pending.push(did);
      if (state.running) {
        pumpDids(pds, state);
      } else if (!state.queued) {
        state.queued = true;
        waiting.push(pds);
        pumpHosts();
      }
    },
    finish() {
      producerDone = true;
      for (const [pds, state] of hosts) {
        if (state.running) pumpDids(pds, state);
      }
      pumpHosts();
      return finished;
    },
  };
}
