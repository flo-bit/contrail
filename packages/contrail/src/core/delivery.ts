import type { ContrailConfig, Database, Logger } from "./types";
import type {
  ChangeClaimOptions,
  ChangeConsumers,
  DeliveryBatch,
} from "./changes";
import type {
  CurrentActivationClaim,
  CurrentSnapshotClaim,
} from "./change-bootstrap";

export interface DeliveryContext<Env> {
  env: Env;
  signal: AbortSignal;
  attempt: number;
}

export type DeliveryHandler<Env> = (
  batch: DeliveryBatch,
  context: DeliveryContext<Env>,
) => Promise<void>;

export type SnapshotDeliveryPage = Omit<CurrentSnapshotClaim, "leaseOwner">;
export type ActivationDelivery = Omit<CurrentActivationClaim, "leaseOwner">;

export interface CurrentBootstrapRuntimeHandler<Env> {
  snapshot: (
    page: SnapshotDeliveryPage,
    context: DeliveryContext<Env>,
  ) => Promise<void>;
  activate: (
    activation: ActivationDelivery,
    context: DeliveryContext<Env>,
  ) => Promise<void>;
}

export type DeliveryHandlers<Env> = Record<string, DeliveryHandler<Env>>;
export type CurrentBootstrapRuntimeHandlers<Env> = Record<
  string,
  CurrentBootstrapRuntimeHandler<Env>
>;

export interface DeliveryRuntimeOptions {
  maxRounds?: number;
  maxDurationMs?: number;
  claim?: ChangeClaimOptions;
  baseRetryMs?: number;
  maxRetryMs?: number;
  jitter?: number;
  signal?: AbortSignal;
  logger?: Logger;
  /** @internal Deterministic runtime seams. */
  clock?: () => number;
  random?: () => number;
}

export interface DeliverySliceResult {
  steps: number;
  delivered: number;
  snapshotPages: number;
  activations: number;
  failures: number;
  consumerErrors: Record<string, string>;
  deadlineReached: boolean;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

export function validateDeliveryHandlers<Env>(
  config: ContrailConfig,
  deliveries: DeliveryHandlers<Env>,
  bootstraps: CurrentBootstrapRuntimeHandlers<Env> = {},
): void {
  const consumers = config.changes?.consumers ?? {};
  for (const id of Object.keys(consumers)) {
    if (typeof deliveries[id] !== "function") {
      throw new Error(`Missing runtime delivery handler for change consumer ${id}`);
    }
    if (
      consumers[id]!.initial === "current" &&
      (!bootstraps[id] ||
        typeof bootstraps[id].snapshot !== "function" ||
        typeof bootstraps[id].activate !== "function")
    ) {
      throw new Error(
        `Missing current-state bootstrap handlers for change consumer ${id}`,
      );
    }
  }
  for (const id of Object.keys(deliveries)) {
    if (!consumers[id]) {
      throw new Error(`Runtime delivery handler ${id} has no static consumer definition`);
    }
  }
  for (const id of Object.keys(bootstraps)) {
    if (!consumers[id] || consumers[id]!.initial !== "current") {
      throw new Error(`Runtime bootstrap handler ${id} has no current consumer definition`);
    }
  }
}

function publicSnapshot(claim: CurrentSnapshotClaim): SnapshotDeliveryPage {
  const { leaseOwner: _leaseOwner, ...page } = claim;
  return page;
}

function publicActivation(claim: CurrentActivationClaim): ActivationDelivery {
  const { leaseOwner: _leaseOwner, ...activation } = claim;
  return activation;
}

async function withDeadline<T>(
  parent: AbortSignal | undefined,
  deadline: number,
  clock: () => number,
  callback: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error("Delivery cancelled"));
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const remaining = Math.max(0, deadline - clock());
  const timer = setTimeout(
    () => controller.abort(new Error("Delivery deadline reached")),
    remaining,
  );
  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

function retryAt(
  attempt: number,
  now: number,
  base: number,
  maximum: number,
  jitter: number,
  random: () => number,
): number {
  const exponential = Math.min(maximum, base * 2 ** Math.min(20, attempt - 1));
  const factor = 1 + (random() * 2 - 1) * jitter;
  return now + Math.max(1, Math.round(exponential * factor));
}

interface RuntimeState<Env> {
  changes: ChangeConsumers;
  config: ContrailConfig;
  db: Database;
  env: Env;
  deliveries: DeliveryHandlers<Env>;
  bootstraps: CurrentBootstrapRuntimeHandlers<Env>;
  claim: ChangeClaimOptions;
  deadline: number;
  baseRetryMs: number;
  maxRetryMs: number;
  jitter: number;
  signal?: AbortSignal;
  logger: Logger;
  clock: () => number;
  random: () => number;
}

async function persistFailure(
  state: RuntimeState<unknown>,
  consumerId: string,
  claim: Parameters<ChangeConsumers["fail"]>[0],
  attempt: number,
): Promise<void> {
  const now = state.clock();
  try {
    await state.changes.fail(
      claim,
      {
        code: "handler_error",
        nextAttemptAt: retryAt(
          attempt,
          now,
          state.baseRetryMs,
          state.maxRetryMs,
          state.jitter,
          state.random,
        ),
      },
      { now },
      state.db,
    );
  } catch (error) {
    state.logger.warn(
      `[changes] consumer=${consumerId} could not persist failure: ${error}`,
    );
  }
}

async function runNormal<Env>(
  state: RuntimeState<Env>,
  consumerId: string,
  bootstrap: boolean,
): Promise<"empty" | "delivered" | "failed"> {
  const now = state.clock();
  const claimOptions = { ...state.claim, now };
  const claim = bootstrap
    ? await state.changes.claimBootstrapChanges(
        consumerId,
        claimOptions,
        state.db,
      )
    : await state.changes.claim(consumerId, claimOptions, state.db);
  if (!claim) return "empty";
  try {
    const batch = await state.changes.hydrate(claim, state.db);
    await withDeadline(state.signal, state.deadline, state.clock, (signal) =>
      state.deliveries[consumerId]!(batch, {
        env: state.env,
        signal,
        attempt: claim.attempt,
      }),
    );
    await state.changes.ack(
      claim,
      { now: state.clock() },
      state.db,
    );
    return "delivered";
  } catch (error) {
    state.logger.warn(`[changes] consumer=${consumerId} delivery failed: ${error}`);
    await persistFailure(
      state as RuntimeState<unknown>,
      consumerId,
      claim,
      claim.attempt,
    );
    return "failed";
  }
}

async function runCurrent<Env>(
  state: RuntimeState<Env>,
  consumerId: string,
): Promise<"empty" | "delivered" | "snapshot" | "activation" | "failed" | "progressed"> {
  const before = await state.changes.bootstrapStatus(consumerId, state.db);
  if (before.state === "ready") {
    return runNormal(state, consumerId, false);
  }
  if (before.state === "pending" || before.state === "scanning") {
    const claim = await state.changes.claimSnapshotPage(
      consumerId,
      { ...state.claim, now: state.clock() },
      state.db,
    );
    if (!claim) {
      const after = await state.changes.bootstrapStatus(consumerId, state.db);
      return after.state !== before.state ? "progressed" : "empty";
    }
    try {
      await withDeadline(state.signal, state.deadline, state.clock, (signal) =>
        state.bootstraps[consumerId]!.snapshot(publicSnapshot(claim), {
          env: state.env,
          signal,
          attempt: claim.attempt,
        }),
      );
      await state.changes.ackSnapshotPage(
        claim,
        { now: state.clock() },
        state.db,
      );
      return "snapshot";
    } catch (error) {
      state.logger.warn(`[changes] consumer=${consumerId} snapshot failed: ${error}`);
      try {
        await state.changes.failSnapshotPage(
          claim,
          {
            code: "snapshot_handler_error",
            nextAttemptAt: retryAt(
              claim.attempt,
              state.clock(),
              state.baseRetryMs,
              state.maxRetryMs,
              state.jitter,
              state.random,
            ),
          },
          { now: state.clock() },
          state.db,
        );
      } catch (failureError) {
        state.logger.warn(`[changes] consumer=${consumerId} snapshot failure state lost: ${failureError}`);
      }
      return "failed";
    }
  }
  if (before.state === "catching-up") {
    const result = await runNormal(state, consumerId, true);
    if (result !== "empty") return result;
    const after = await state.changes.bootstrapStatus(consumerId, state.db);
    return after.state !== before.state ? "progressed" : "empty";
  }
  if (before.state === "activating") {
    const claim = await state.changes.claimActivation(
      consumerId,
      { leaseMs: state.claim.leaseMs, now: state.clock() },
      state.db,
    );
    if (!claim) return "empty";
    try {
      await withDeadline(state.signal, state.deadline, state.clock, (signal) =>
        state.bootstraps[consumerId]!.activate(publicActivation(claim), {
          env: state.env,
          signal,
          attempt: claim.attempt,
        }),
      );
      await state.changes.completeActivation(
        claim,
        { now: state.clock() },
        state.db,
      );
      return "activation";
    } catch (error) {
      state.logger.warn(`[changes] consumer=${consumerId} activation failed: ${error}`);
      try {
        await state.changes.failActivation(
          claim,
          {
            code: "activation_handler_error",
            nextAttemptAt: retryAt(
              claim.attempt,
              state.clock(),
              state.baseRetryMs,
              state.maxRetryMs,
              state.jitter,
              state.random,
            ),
          },
          { now: state.clock() },
          state.db,
        );
      } catch (failureError) {
        state.logger.warn(`[changes] consumer=${consumerId} activation failure state lost: ${failureError}`);
      }
      return "failed";
    }
  }
  return "empty";
}

/** Run fair round-robin delivery work without coupling failures to ingestion. */
export async function runChangeDeliverySlice<Env>(options: {
  changes: ChangeConsumers;
  config: ContrailConfig;
  db: Database;
  env: Env;
  deliveries: DeliveryHandlers<Env>;
  bootstraps?: CurrentBootstrapRuntimeHandlers<Env>;
  runtime?: DeliveryRuntimeOptions;
}): Promise<DeliverySliceResult> {
  const bootstraps = options.bootstraps ?? {};
  validateDeliveryHandlers(options.config, options.deliveries, bootstraps);
  const runtime = options.runtime ?? {};
  const clock = runtime.clock ?? Date.now;
  const maxRounds = boundedInteger(runtime.maxRounds, 4, 1, 100, "maxRounds");
  const maxDurationMs = boundedInteger(
    runtime.maxDurationMs,
    15_000,
    1,
    10 * 60_000,
    "maxDurationMs",
  );
  const baseRetryMs = boundedInteger(
    runtime.baseRetryMs,
    1_000,
    1,
    60 * 60_000,
    "baseRetryMs",
  );
  const maxRetryMs = boundedInteger(
    runtime.maxRetryMs,
    60 * 60_000,
    baseRetryMs,
    48 * 60 * 60_000,
    "maxRetryMs",
  );
  const jitter = runtime.jitter ?? 0.2;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError("jitter must be between 0 and 1");
  }
  const deadline = clock() + maxDurationMs;
  const state: RuntimeState<Env> = {
    changes: options.changes,
    config: options.config,
    db: options.db,
    env: options.env,
    deliveries: options.deliveries,
    bootstraps,
    claim: runtime.claim ?? {},
    deadline,
    baseRetryMs,
    maxRetryMs,
    jitter,
    signal: runtime.signal,
    logger: runtime.logger ?? options.config.logger ?? console,
    clock,
    random: runtime.random ?? Math.random,
  };
  const result: DeliverySliceResult = {
    steps: 0,
    delivered: 0,
    snapshotPages: 0,
    activations: 0,
    failures: 0,
    consumerErrors: {},
    deadlineReached: false,
  };
  const consumers = Object.entries(options.config.changes?.consumers ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );

  for (let round = 0; round < maxRounds; round++) {
    let progressed = false;
    for (const [consumerId, consumer] of consumers) {
      if (runtime.signal?.aborted || clock() >= deadline) {
        result.deadlineReached = true;
        return result;
      }
      try {
        const outcome = consumer.initial === "current"
          ? await runCurrent(state, consumerId)
          : await runNormal(state, consumerId, false);
        if (outcome !== "empty") {
          progressed = true;
          result.steps++;
        }
        if (outcome === "delivered") result.delivered++;
        else if (outcome === "snapshot") result.snapshotPages++;
        else if (outcome === "activation") result.activations++;
        else if (outcome === "failed") result.failures++;
      } catch (error) {
        result.failures++;
        result.consumerErrors[consumerId] =
          error instanceof Error ? error.message : String(error);
        state.logger.error(`[changes] consumer=${consumerId} runtime failed: ${error}`);
      }
    }
    if (!progressed) break;
  }
  result.deadlineReached = clock() >= deadline;
  return result;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Persistent fair supervisor. Source ingestion remains a separate task and is
 * never cancelled by a destination outage. */
export async function runPersistentChangeDeliveries<Env>(options: {
  changes: ChangeConsumers;
  config: ContrailConfig;
  db: Database;
  env: Env;
  deliveries: DeliveryHandlers<Env>;
  bootstraps?: CurrentBootstrapRuntimeHandlers<Env>;
  runtime?: DeliveryRuntimeOptions & { idleMs?: number };
}): Promise<void> {
  const idleMs = boundedInteger(
    options.runtime?.idleMs,
    1_000,
    1,
    60_000,
    "idleMs",
  );
  while (!options.runtime?.signal?.aborted) {
    const result = await runChangeDeliverySlice(options);
    if (result.steps === 0) {
      await waitFor(idleMs, options.runtime?.signal);
    }
  }
}
