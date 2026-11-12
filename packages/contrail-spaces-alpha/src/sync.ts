import { parseCid } from "@atproto/lex-data";
import { lexToJson } from "@atproto/lex-json";
import {
  RepoCommit,
  serializeRecord,
  verifyCommit,
  verifyRepoStarFull,
  type Commit,
} from "@atproto/space";
import {
  activateIsolatedPartitionStatement,
  createIngestEvent,
  createIsolatedProjection,
  deleteIsolatedPartitionGeneration,
  hideIsolatedPartitionStatement,
  ingestRecords,
  rebuildIsolatedCountsStatements,
  recordTimeUs,
  validateCanonicalRecord,
  type ContrailConfig,
  type Database,
  type IngestEvent,
  type Statement,
} from "@atmo-dev/contrail";
import { delegationFailure } from "./crypto";
import {
  exchangeSpaceCredential,
  getRepoStar,
  getPublishedSpacePolicy,
  listRepoOps,
  listRepos,
  registerNotify,
  SpaceCredentialTransport,
  SpaceIdentityResolver,
  SpaceProtocolError,
  type ProtocolOptions,
  type RepoOp,
  type ListRepoOpsOutput,
} from "./protocol";
import {
  acquireSyncLease,
  advanceSpaceRev,
  clearRepoFailure,
  deleteRepoState,
  getRepoState,
  getSpaceWatch,
  hideDeletedSpace,
  invalidateRevokedCredential,
  listDueWatches,
  listRepoFailures,
  listRepoStates,
  loadCredential,
  purgeSpaceGeneration,
  recordRepoFailure,
  releaseSyncLease,
  renewSyncLease,
  REPO_FAILURE_MAX_BACKOFF_MS,
  revBefore,
  saveCredential,
  saveRepoStateStatement,
  syncLeaseFenceStatements,
  updateWatch,
  type SpaceRepoState,
  type SpaceWatch,
} from "./storage";
import { formatSpaceRecordUri, parseSpaceUri, spaceProjectionKey } from "./uri";

import {
  isAuthorityDecidedPolicy,
  isSyncedSpacePolicy,
  type SpaceTypePolicy,
} from "./policy";

export interface SpaceTypeConfig {
  collections: readonly string[];
  skey?: string;
  /** Access configuration asserted against the authority's authenticated policy
   * record. The owner must enable publishPolicy on the PDS. An
   * `{ $type: "authority" }` policy skips that check: the authority host
   * decides access by itself. */
  policy: SpaceTypePolicy;
}

export interface SpacesSyncBudget {
  /** Maximum whole-repo operations verified from one incremental checkpoint.
   * Operations from excluded collections still consume this bound. */
  maxIncrementalOperations: number;
  /** Maximum in-scope records projected by one staged recovery batch. */
  recoveryBatchSize: number;
}

export type SpacesSyncBudgetOptions = Partial<SpacesSyncBudget>;

export const DEFAULT_SPACES_SYNC_BUDGET = Object.freeze({
  maxIncrementalOperations: 50,
  recoveryBatchSize: 50,
}) satisfies SpacesSyncBudget;

/** Incremental operations are projected in one atomic batch with their
 * checkpoint, so runtimes with small transaction limits should stay near the
 * default. Past the bound a writer is recovered from its full archive. */
const MAX_INCREMENTAL_OPERATIONS = 1000;
const MAX_RECOVERY_BATCH_SIZE = 50;

function boundedSyncInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(
      `${label} must be an integer from 1 through ${maximum}`,
    );
  }
  return value;
}

export function resolveSpacesSyncBudget(
  value: SpacesSyncBudgetOptions = {},
): SpacesSyncBudget {
  return {
    maxIncrementalOperations: boundedSyncInteger(
      value.maxIncrementalOperations ??
        DEFAULT_SPACES_SYNC_BUDGET.maxIncrementalOperations,
      "syncBudget.maxIncrementalOperations",
      MAX_INCREMENTAL_OPERATIONS,
    ),
    recoveryBatchSize: boundedSyncInteger(
      value.recoveryBatchSize ?? DEFAULT_SPACES_SYNC_BUDGET.recoveryBatchSize,
      "syncBudget.recoveryBatchSize",
      MAX_RECOVERY_BATCH_SIZE,
    ),
  };
}

export interface SpacesSyncConfig {
  projection: ContrailConfig;
  spaceTypes: Record<string, SpaceTypeConfig>;
  serviceAudience: string;
  credentialEncryptionKey: string;
  reconcileIntervalMs?: number;
  /** How often reconciliation lists every writer instead of only those
   * updated since the last processed space revision (default one hour). */
  fullReconcileIntervalMs?: number;
  /** Mint a fresh delegation token for background sync when the stored
   * credential is missing or about to expire. Return null when no session can
   * mint one; the Space then pauses until a user authorizes it again. */
  renewCredential?: (input: {
    spaceUri: string;
    authorityDid: string;
    /** The user whose delegation produced the previous credential. */
    viewerDid?: string;
  }) => Promise<CredentialRenewal | null>;
  notificationRegistration?: "required" | "best-effort" | "disabled";
  registrationRenewalWindowMs?: number;
  syncBudget?: SpacesSyncBudgetOptions;
  /** Maximum complete STAR archive buffered by the Worker (default 16 MiB). */
  maxRepoStarBytes?: number;
  protocol?: ProtocolOptions;
  logger?: Pick<Console, "log" | "warn" | "error">;
  onInvalidate?: (spaceUri: string) => void | Promise<void>;
}

export interface CredentialRenewal {
  userDid: string;
  delegation: string;
}

export type SyncRepoOutcome =
  /** Projection advanced to the host's latest verified commit. */
  | "synced"
  /** The notified revision was already applied. */
  | "unchanged"
  /** The host still serves a revision older than the one notified. */
  | "behind"
  /** The writer's host failed; recorded with backoff, other writers continue. */
  | "failed"
  /** Another worker holds this writer's sync lease. */
  | "busy"
  /** The Space is not active. */
  | "skipped"
  /** The authority confirmed the Space was deleted. */
  | "deleted";

export interface SyncRepoResult {
  outcome: SyncRepoOutcome;
  /** Notifications between the checkpoint and this one were missed; the
   * caller should reconcile the Space to catch up. */
  catchUp: boolean;
}

export interface ReconcileOptions {
  limit?: number;
  deadline?: number;
}

const SYNC_LEASE_TTL_MS = 90_000;
const CREDENTIAL_RENEWAL_WINDOW_MS = 5 * 60_000;
/** Waits before re-reading a host that has not caught up to its own
 * notification yet. */
const CHASE_DELAYS_MS = [300, 1_000];
const WATCH_FAILURE_MAX_BACKOFF_MS = 60 * 60_000;

/** Hosts answer these for a writer's own repo. Takedown hides the writer's
 * records; the others keep the verified copy and retry later. */
const WRITER_TAKEDOWN = "RepoTakendown";
/** The archive would answer the same, so do not fall back to recovery. */
const WRITER_UNAVAILABLE = new Set([WRITER_TAKEDOWN, "RepoDeactivated"]);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  if (error instanceof SpaceProtocolError)
    return error.message === error.code
      ? error.code
      : `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Sync failed";
}

/** A claim about the Space or its credential, as opposed to one repo. */
function spaceLevel(error: unknown): error is SpaceProtocolError {
  return (
    error instanceof SpaceProtocolError &&
    (error.deleted || error.accessDenied || error.code === "CredentialExpired")
  );
}

interface LoadedCredentialTransport {
  transport: SpaceCredentialTransport;
  encryptedValue: string;
}

class SyncLeaseLostError extends Error {
  constructor() {
    super("Space repo sync lease was lost");
    this.name = "SyncLeaseLostError";
  }
}

class SyncDeadlineExceededError extends Error {
  constructor() {
    super("Space reconciliation deadline reached during incremental sync");
    this.name = "SyncDeadlineExceededError";
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function collectionAllowed(
  config: SpacesSyncConfig,
  watch: SpaceWatch,
  collection: string,
): boolean {
  return (
    config.spaceTypes[watch.spaceType]?.collections.includes(collection) ??
    false
  );
}

export class SpacesSyncEngine {
  readonly identities: SpaceIdentityResolver;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly budget: SpacesSyncBudget;

  constructor(
    readonly db: Database,
    readonly config: SpacesSyncConfig,
  ) {
    this.identities = new SpaceIdentityResolver(config.protocol);
    this.logger = config.logger ?? console;
    this.budget = resolveSpacesSyncBudget(config.syncBudget);
  }

  private scope(watch: SpaceWatch) {
    return {
      kind: "isolated" as const,
      key: spaceProjectionKey(watch.spaceUri, watch.generation),
    };
  }

  private async transport(
    watch: SpaceWatch,
  ): Promise<LoadedCredentialTransport> {
    const load = () =>
      loadCredential(this.db, {
        spaceUri: watch.spaceUri,
        generation: watch.generation,
        encryptionKey: this.config.credentialEncryptionKey,
      });
    let stored = await load();
    if (
      this.config.renewCredential &&
      (!stored ||
        stored.credential.expiresAt - Date.now() < CREDENTIAL_RENEWAL_WINDOW_MS)
    ) {
      if (await this.renewCredential(watch, stored?.viewerDid, !stored))
        stored = await load();
    }
    if (!stored) {
      await updateWatch(this.db, watch.spaceUri, {
        status: "paused",
        error: "No unexpired Space credential",
        expectedGeneration: watch.generation,
      });
      throw new SpaceProtocolError(401, "CredentialExpired");
    }
    return {
      transport: await SpaceCredentialTransport.restore(
        stored.credential,
        this.config.protocol?.fetch,
      ),
      encryptedValue: stored.encryptedValue,
    };
  }

  /** Exchange an application-minted delegation for a new sync credential.
   * A usable stored credential outlives a failed renewal. Without one, a
   * failing hook is transient and must not pause the Space; only "no session
   * can mint" (null) or an authority refusal does. */
  private async renewCredential(
    watch: SpaceWatch,
    viewerDid: string | undefined,
    required: boolean,
  ): Promise<boolean> {
    try {
      const renewal = await this.config.renewCredential!({
        spaceUri: watch.spaceUri,
        authorityDid: watch.authorityDid,
        viewerDid,
      });
      if (!renewal) return false;
      const failure = delegationFailure(renewal.delegation, {
        userDid: renewal.userDid,
        spaceUri: watch.spaceUri,
      });
      if (failure) throw new Error(`Renewal delegation rejected: ${failure}`);
      const transport = await exchangeSpaceCredential({
        authorityPds: await this.identities.resolvePds(watch.authorityDid),
        delegationToken: renewal.delegation,
        spaceUri: watch.spaceUri,
        fetch: this.config.protocol?.fetch,
      });
      await saveCredential(this.db, {
        spaceUri: watch.spaceUri,
        generation: watch.generation,
        viewerDid: renewal.userDid,
        credential: await transport.serialize(),
        encryptionKey: this.config.credentialEncryptionKey,
      });
      return true;
    } catch (error) {
      if (error instanceof SpaceProtocolError && error.deleted) throw error;
      const refused = error instanceof SpaceProtocolError && error.accessDenied;
      if (required && !refused) throw error;
      this.logger.warn(
        `[spaces] credential renewal failed for ${watch.spaceUri}`,
        error,
      );
      return false;
    }
  }

  /** Ask the authority whether a Space-level claim made by a writer's host is
   * true. Throws the authority's own answer if it agrees. */
  private async confirmWithAuthority(
    watch: SpaceWatch,
    transport: SpaceCredentialTransport,
  ): Promise<void> {
    try {
      await listRepos(
        transport,
        await this.identities.resolvePds(watch.authorityDid),
        { space: watch.spaceUri, limit: 1 },
      );
    } catch (error) {
      if (spaceLevel(error)) throw error;
      // An unreachable authority confirms nothing.
    }
  }

  private async invalidateRevoked(
    watch: SpaceWatch,
    credential: LoadedCredentialTransport | undefined,
    error: unknown,
  ): Promise<boolean> {
    if (
      !(error instanceof SpaceProtocolError) ||
      error.code !== "CredentialRevoked"
    )
      return false;
    if (credential) {
      await invalidateRevokedCredential(this.db, {
        spaceUri: watch.spaceUri,
        generation: watch.generation,
        encryptedValue: credential.encryptedValue,
      });
    }
    return true;
  }

  async validateWatch(
    watch: SpaceWatch,
    suppliedTransport?: SpaceCredentialTransport,
  ): Promise<void> {
    const transport =
      suppliedTransport ?? (await this.transport(watch)).transport;
    const parsed = parseSpaceUri(watch.spaceUri);
    const type = this.config.spaceTypes[parsed.type];
    if (!type) throw new Error(`Unsupported Space type: ${parsed.type}`);
    if (type.skey !== undefined && parsed.skey !== type.skey) {
      throw new Error(`Unsupported Space key for ${parsed.type}`);
    }
    // The authority host decides access by itself; it need not publish a
    // policy, and the credential it issued is the assertion.
    if (isAuthorityDecidedPolicy(type.policy)) return;
    const read = async (forceRefresh: boolean) => {
      const kemDidKey = await this.identities.resolveKemKey(
        parsed.authorityDid,
        forceRefresh,
      );
      const authorityPds = await this.identities.resolvePds(
        parsed.authorityDid,
      );
      return getPublishedSpacePolicy(transport, authorityPds, watch.spaceUri, {
        kemDidKey,
      });
    };
    let policy: unknown;
    try {
      try {
        policy = await read(false);
      } catch (error) {
        if (error instanceof SpaceProtocolError) throw error;
        policy = await read(true); // KEM rotation: new key share and refreshed DID.
      }
    } catch (error) {
      if (error instanceof SpaceProtocolError) {
        if (!["RecordNotFound", "RepoNotFound"].includes(error.code))
          throw error;
        throw new SpaceProtocolError(
          403,
          "PolicyNotPublished",
          "The owner must enable publishPolicy before connecting this Space",
        );
      }
      throw new SpaceProtocolError(
        403,
        "PolicyVerificationFailed",
        "Could not authenticate the authority's published Space policy",
      );
    }
    function mismatch(message: string): never {
      throw new SpaceProtocolError(403, "PolicyMismatch", message);
    }
    if (!isSyncedSpacePolicy(policy) || policy.publishPolicy !== true) {
      mismatch("Space has no supported published policy");
    }
    const expected = type.policy;
    if (policy.$type !== expected.$type)
      mismatch("Space policy type does not match configuration");
    if (policy.$type === "com.atproto.memberspace.policy") {
      if (
        expected.$type !== policy.$type ||
        Boolean(policy.publicRead) !== Boolean(expected.publicRead) ||
        Boolean(policy.publicWrite) !== Boolean(expected.publicWrite)
      ) {
        mismatch("Space publicRead/publicWrite does not match configuration");
      }
      if (policy.allowedApps !== undefined) {
        mismatch(
          "App-attestation allowlists are not supported by this provider",
        );
      }
    } else if (
      expected.$type !== policy.$type ||
      policy.managingApp !== expected.managingApp ||
      policy.managingApp !== this.config.serviceAudience
    ) {
      mismatch("Space is managed by a different application");
    }
  }

  async reconcileDue(options: ReconcileOptions = {}): Promise<number> {
    const limit = Math.min(Math.max(1, options.limit ?? 5), 50);
    const deadline = options.deadline ?? Date.now() + 25_000;
    const watches = await listDueWatches(this.db, Date.now(), limit);
    let completed = 0;
    for (const watch of watches) {
      if (Date.now() >= deadline) break;
      try {
        await this.reconcileSpace(watch.spaceUri, { deadline });
        completed++;
      } catch (error) {
        this.logger.error(
          `[spaces] reconciliation failed for ${watch.spaceUri}`,
          error,
        );
      }
    }
    return completed;
  }

  async reconcileSpace(
    spaceUri: string,
    options: { deadline?: number; preferredRepo?: string; full?: boolean } = {},
  ): Promise<void> {
    const watch = await getSpaceWatch(this.db, spaceUri);
    if (!watch || watch.status !== "active") return;
    const deadline = options.deadline ?? Date.now() + 25_000;
    let credential: LoadedCredentialTransport | undefined;
    try {
      credential = await this.transport(watch);
      const { transport } = credential;
      await this.validateWatch(watch, transport);
      const authorityPds = await this.identities.resolvePds(watch.authorityDid);
      const registrationMode =
        this.config.notificationRegistration ?? "best-effort";
      const renewalWindow =
        this.config.registrationRenewalWindowMs ?? 60 * 60_000;
      if (
        registrationMode !== "disabled" &&
        (watch.registrationPdsUrl !== authorityPds ||
          !watch.registrationExpiresAt ||
          Date.parse(watch.registrationExpiresAt) - Date.now() < renewalWindow)
      ) {
        try {
          const registration = await registerNotify(transport, authorityPds, {
            space: watch.spaceUri,
            service: this.config.serviceAudience,
          });
          await updateWatch(this.db, watch.spaceUri, {
            registrationExpiresAt: registration.expiresAt,
            registrationPdsUrl: authorityPds,
            expectedGeneration: watch.generation,
            expectedStatus: "active",
          });
        } catch (error) {
          if (
            registrationMode === "required" ||
            (error instanceof SpaceProtocolError && error.accessDenied)
          )
            throw error;
          this.logger.warn(
            "[spaces] notification registration failed; reconciliation continues",
            error,
          );
        }
      }

      const local = new Map(
        (await listRepoStates(this.db, watch)).map((state) => [
          state.repoDid,
          state,
        ]),
      );
      const failures = new Map(
        (await listRepoFailures(this.db, watch)).map((failure) => [
          failure.repoDid,
          failure,
        ]),
      );
      const preferred = options.preferredRepo;
      const attempted = new Set<string>();
      const pass = {
        /** The Space was deleted or deactivated under us. */
        halted: false,
        /** Out of time, or halted: start no more work. */
        stopped: false,
        /** Some writer is neither current nor on the retry list, so the
         * processed revision must not move past it. */
        unfinished: false,
      };
      const sync = async (repoDid: string): Promise<boolean> => {
        if (Date.now() >= deadline) {
          pass.unfinished = pass.stopped = true;
          return false;
        }
        attempted.add(repoDid);
        const failure = failures.get(repoDid);
        // A backed-off writer stays on the retry list; it does not hold up
        // the others or the checkpoint.
        if (failure && failure.retryAfter > Date.now() && repoDid !== preferred)
          return true;
        try {
          const { outcome } = await this.syncRepo(
            watch.spaceUri,
            repoDid,
            undefined,
            { deadline },
          );
          if (outcome === "deleted" || outcome === "skipped") {
            pass.halted = pass.stopped = true;
            return false;
          }
          if (outcome === "busy") pass.unfinished = true;
          return true;
        } catch (error) {
          if (error instanceof SyncDeadlineExceededError) {
            pass.unfinished = pass.stopped = true;
            return false;
          }
          if (error instanceof SyncLeaseLostError) {
            pass.unfinished = true;
            return true;
          }
          throw error;
        }
      };

      // An integrated application names the writer it just wrote for. Its
      // host is the source of truth, so do not wait for the authority's
      // listing to catch up.
      if (preferred && local.has(preferred)) await sync(preferred);

      // The listing is ordered by space revision, so the checkpoint advances
      // page by page and an interrupted pass resumes where it stopped. A full
      // pass starts from the beginning to repair anything the incremental
      // cursor could not see.
      const full =
        options.full === true ||
        !watch.spaceRev ||
        !watch.lastFullReconcileAt ||
        Date.now() - watch.lastFullReconcileAt >=
          (this.config.fullReconcileIntervalMs ?? 60 * 60_000);
      let cursor = full ? undefined : (watch.spaceRev ?? undefined);
      let listed = false;
      while (!pass.stopped) {
        if (Date.now() >= deadline) {
          pass.unfinished = pass.stopped = true;
          break;
        }
        const page = await listRepos(transport, authorityPds, {
          space: watch.spaceUri,
          limit: 1000,
          cursor,
        });
        let pageRev: string | undefined;
        const stale: string[] = [];
        for (const repo of page.repos) {
          if (
            !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(repo.did) ||
            !repo.repoRev ||
            !repo.spaceRev ||
            !(repo.data instanceof Uint8Array) ||
            repo.data.byteLength !== 32
          ) {
            throw new Error("Space authority returned an invalid writer entry");
          }
          if (!pageRev || revBefore(pageRev, repo.spaceRev))
            pageRev = repo.spaceRev;
          const state = local.get(repo.did);
          if (
            !attempted.has(repo.did) &&
            (!state ||
              state.rev !== repo.repoRev ||
              !bytesEqual(state.commitHash, repo.data))
          )
            stale.push(repo.did);
        }
        if (preferred && stale.includes(preferred)) {
          stale.splice(stale.indexOf(preferred), 1);
          stale.unshift(preferred);
        }
        for (const repoDid of stale) if (!(await sync(repoDid))) break;
        if (pass.stopped) break;
        if (pageRev && !pass.unfinished)
          await advanceSpaceRev(this.db, watch, { spaceRev: pageRev });
        const next = page.repos.length ? page.cursor : undefined;
        if (!next) {
          listed = true;
          break;
        }
        if (next === cursor)
          throw new Error("Writer listing cursor did not advance");
        cursor = next;
      }

      // Omission in a latest-state listing does not prove writer removal.
      // Keep verified records until authoritative deletion evidence arrives.

      // Writers that failed earlier are retried from the retry list: an
      // incremental listing will not mention them again until they write.
      for (const repoDid of failures.keys()) {
        if (pass.stopped) break;
        if (!attempted.has(repoDid)) await sync(repoDid);
      }
      if (pass.halted) return;

      const now = Date.now();
      await updateWatch(this.db, watch.spaceUri, {
        status: "active",
        error: null,
        reconciledAt: now,
        // Unfinished work is due again on the next pass, not a full interval
        // later.
        nextReconcileAt: pass.unfinished
          ? now
          : now + (this.config.reconcileIntervalMs ?? 5 * 60_000),
        consecutiveFailures: 0,
        fullReconciledAt: full && listed ? now : undefined,
        expectedGeneration: watch.generation,
        expectedStatus: "active",
      });
    } catch (error) {
      if (error instanceof SpaceProtocolError && error.deleted) {
        await this.deleteSpace(watch);
        return;
      }
      // Do not let stale work pause a concurrently reauthorized connection.
      if (await this.invalidateRevoked(watch, credential, error)) throw error;
      const paused =
        error instanceof SpaceProtocolError &&
        (error.accessDenied || error.code === "CredentialExpired");
      const failed = watch.consecutiveFailures + 1;
      await updateWatch(this.db, watch.spaceUri, {
        status: paused ? "paused" : watch.status,
        error: errorMessage(error).slice(0, 500),
        nextReconcileAt:
          Date.now() +
          Math.min(
            WATCH_FAILURE_MAX_BACKOFF_MS,
            60_000 * 2 ** Math.min(failed - 1, 10),
          ),
        consecutiveFailures: failed,
        expectedGeneration: watch.generation,
        expectedStatus: "active",
      });
      throw error;
    }
  }

  /** Bring one writer's repo current.
   *
   * Only Space-level failures are thrown: the authority (or this service's
   * own credential state) says the Space is deleted, access is gone, or the
   * credential is revoked. A writer's host is authoritative for that writer's
   * repo and nothing else, so its failures are recorded with backoff and
   * reported as `failed`; when such a host makes a Space-level claim, the
   * authority is asked to confirm before anything is paused or purged. */
  async syncRepo(
    spaceUri: string,
    repoDid: string,
    advertised?: {
      rev?: string;
      hash?: Uint8Array;
      /** Sequencing from an authority-forwarded notification. */
      spaceRev?: string;
      prevSpaceRev?: string;
    },
    options: { deadline?: number } = {},
  ): Promise<SyncRepoResult> {
    const watch = await getSpaceWatch(this.db, spaceUri);
    if (!watch || watch.status !== "active")
      return { outcome: "skipped", catchUp: false };
    // Once the writer is current or on the retry list the notification is
    // processed, and the checkpoint may move if nothing before it was missed.
    const settle = async (
      outcome: SyncRepoOutcome,
    ): Promise<SyncRepoResult> => ({
      outcome,
      catchUp: advertised?.spaceRev
        ? !(await advanceSpaceRev(this.db, watch, {
            spaceRev: advertised.spaceRev,
            prevSpaceRev: advertised.prevSpaceRev,
            contiguousOnly: true,
          }))
        : false,
    });
    const alreadyApplied = async (): Promise<boolean> => {
      if (!advertised?.rev) return false;
      const state = await getRepoState(this.db, watch, repoDid);
      if (!state || revBefore(state.rev, advertised.rev)) return false;
      return !(
        state.rev === advertised.rev &&
        advertised.hash &&
        !bytesEqual(state.commitHash, advertised.hash)
      );
    };
    const owner = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      // Duplicate and out-of-order notifications cost one local read.
      if (await alreadyApplied()) return settle("unchanged");
      if (
        await acquireSyncLease(this.db, {
          spaceUri,
          generation: watch.generation,
          repoDid,
          owner,
          ttlMs: SYNC_LEASE_TTL_MS,
        })
      )
        break;
      // Another worker is syncing this writer, possibly from before the
      // notified write. Wait briefly for it rather than dropping the update.
      const delay = advertised?.rev ? CHASE_DELAYS_MS[attempt] : undefined;
      if (
        delay === undefined ||
        (options.deadline !== undefined &&
          Date.now() + delay >= options.deadline)
      )
        return { outcome: "busy", catchUp: false };
      await sleep(delay);
    }
    // Every durable stage renews this owner token first. Work may outlive the
    // original TTL while downloading/verifying, but a worker that loses the
    // lease is fenced before it can resume projection or checkpoint writes.
    const assertLease = async (): Promise<void> => {
      if (
        !(await renewSyncLease(this.db, {
          spaceUri,
          generation: watch.generation,
          repoDid,
          owner,
          ttlMs: SYNC_LEASE_TTL_MS,
        }))
      ) {
        throw new SyncLeaseLostError();
      }
    };
    const fence = () =>
      syncLeaseFenceStatements(this.db, {
        spaceUri,
        generation: watch.generation,
        repoDid,
        owner,
      });
    let credential: LoadedCredentialTransport | undefined;
    let hostContacted = false;
    try {
      const currentWatch = await getSpaceWatch(this.db, spaceUri);
      if (
        !currentWatch ||
        currentWatch.generation !== watch.generation ||
        currentWatch.status !== "active"
      )
        return { outcome: "skipped", catchUp: false };
      credential = await this.transport(watch);
      const { transport } = credential;
      await assertLease();
      hostContacted = true;
      let behind = false;
      for (let attempt = 0; ; attempt++) {
        await this.syncRepoOnce(
          watch,
          repoDid,
          transport,
          assertLease,
          fence,
          options.deadline,
        );
        const updated = await getRepoState(this.db, watch, repoDid);
        if (
          advertised?.hash &&
          updated &&
          advertised.rev === updated.rev &&
          !bytesEqual(updated.commitHash, advertised.hash)
        ) {
          throw new Error(
            "Synchronized commit did not match notification target hash",
          );
        }
        behind = Boolean(
          advertised?.rev && updated && revBefore(updated.rev, advertised.rev),
        );
        if (!behind) break;
        // The host has not caught up to its own notification yet.
        const delay = CHASE_DELAYS_MS[attempt];
        if (
          delay === undefined ||
          (options.deadline !== undefined &&
            Date.now() + delay >= options.deadline)
        )
          break;
        await sleep(delay);
        await assertLease();
      }
      if (behind) {
        await recordRepoFailure(this.db, watch, repoDid, {
          error: "Repo host is behind its notified revision",
          retryInMs: 30_000,
        });
      } else {
        await clearRepoFailure(this.db, watch, repoDid);
      }
      await this.config.onInvalidate?.(spaceUri);
      return await settle(behind ? "behind" : "synced");
    } catch (error) {
      if (
        error instanceof SyncLeaseLostError ||
        error instanceof SyncDeadlineExceededError
      )
        throw error;
      let spaceError: unknown;
      if (!hostContacted) {
        spaceError = error;
      } else if (spaceLevel(error)) {
        if (
          repoDid === watch.authorityDid ||
          error.code === "CredentialExpired"
        ) {
          spaceError = error;
        } else {
          // A member's host cannot delete the Space, revoke our credential or
          // deny access to it. Believe that only from the authority.
          try {
            await this.confirmWithAuthority(watch, credential!.transport);
          } catch (confirmed) {
            spaceError = confirmed;
          }
        }
      }
      if (spaceError !== undefined) {
        if (spaceError instanceof SpaceProtocolError && spaceError.deleted) {
          await assertLease();
          await this.deleteSpace(watch);
          return { outcome: "deleted", catchUp: false };
        }
        await this.invalidateRevoked(watch, credential, spaceError);
        throw spaceError;
      }

      const takedown =
        error instanceof SpaceProtocolError && error.code === WRITER_TAKEDOWN;
      if (takedown) {
        // Stop serving a taken-down account's records, as public indexes do.
        // The repo is recovered in full if the account is reinstated.
        const state = await getRepoState(this.db, watch, repoDid);
        if (state) {
          await assertLease();
          await this.removeWriter(watch, state);
        }
      }
      const message = errorMessage(error);
      const failure = await recordRepoFailure(this.db, watch, repoDid, {
        error: message,
        retryInMs: takedown ? REPO_FAILURE_MAX_BACKOFF_MS : undefined,
      });
      this.logger.warn(
        `[spaces] writer ${repoDid} failed in ${spaceUri} (${failure.failures}x): ${message}`,
      );
      return await settle("failed");
    } finally {
      await releaseSyncLease(this.db, {
        spaceUri,
        generation: watch.generation,
        repoDid,
        owner,
      });
    }
  }

  private async syncRepoOnce(
    watch: SpaceWatch,
    repoDid: string,
    transport: SpaceCredentialTransport,
    assertLease: () => Promise<void>,
    fence: () => Statement[],
    deadline?: number,
  ): Promise<void> {
    const state = await getRepoState(this.db, watch, repoDid);
    if (!state) {
      await this.recoverRepo(watch, repoDid, transport, assertLease, fence);
      return;
    }
    try {
      await this.incrementalRepo(
        watch,
        state,
        transport,
        assertLease,
        deadline,
        fence,
      );
    } catch (error) {
      if (
        error instanceof SyncLeaseLostError ||
        error instanceof SyncDeadlineExceededError ||
        spaceLevel(error) ||
        (error instanceof SpaceProtocolError &&
          WRITER_UNAVAILABLE.has(error.code))
      )
        throw error;
      this.logger.warn(
        `[spaces] incremental sync fell back to recovery for ${watch.spaceUri} ${repoDid}`,
        error,
      );
      await this.recoverRepo(watch, repoDid, transport, assertLease, fence);
    }
  }

  private async incrementalRepo(
    watch: SpaceWatch,
    local: SpaceRepoState,
    transport: SpaceCredentialTransport,
    assertLease: () => Promise<void>,
    deadline?: number,
    fence: () => Statement[] = () => [],
  ): Promise<void> {
    const writerPds = await this.identities.resolvePds(local.repoDid);
    const state = RepoCommit.fromState(local.ltHash);
    const finalProjectionOps = new Map<
      string,
      { operation: RepoOp; order: number }
    >();
    let operationCount = 0;
    let cursor: string | undefined;
    let commit: Commit | undefined;
    do {
      const remainingMs =
        deadline === undefined ? undefined : deadline - Date.now();
      if (remainingMs !== undefined && remainingMs <= 0) {
        throw new SyncDeadlineExceededError();
      }
      const signal =
        remainingMs === undefined
          ? undefined
          : AbortSignal.timeout(Math.max(1, remainingMs));
      let page;
      try {
        page = await this.verifiedOps(
          transport,
          writerPds,
          {
            space: watch.spaceUri,
            repo: local.repoDid,
            since: local.rev,
            cursor,
            limit: Math.min(
              1000,
              this.budget.maxIncrementalOperations - operationCount + 1,
            ),
          },
          { signal },
        );
      } catch (error) {
        if (signal?.aborted) throw new SyncDeadlineExceededError();
        throw error;
      }
      for (const operation of page.ops) {
        operationCount++;
        if (operationCount > this.budget.maxIncrementalOperations) {
          throw new Error(
            "Incremental sync exceeds the bounded operation limit",
          );
        }
        state.applyOp({
          collection: operation.collection,
          rkey: operation.rkey,
          cid: operation.cid ? parseCid(operation.cid) : null,
          prev: operation.prev ? parseCid(operation.prev) : null,
        });
        if (!collectionAllowed(this.config, watch, operation.collection))
          continue;
        finalProjectionOps.set(`${operation.collection}\0${operation.rkey}`, {
          operation,
          order: operationCount,
        });
      }
      cursor = page.cursor;
      if (page.commit && page.cursor)
        throw new Error("Commit received before the final operation page");
      if (!page.cursor) commit = page.commit;
      // A cursor proves that at least one more whole-repo operation remains.
      if (cursor && operationCount >= this.budget.maxIncrementalOperations) {
        throw new Error("Incremental sync exceeds the bounded operation limit");
      }
    } while (cursor);
    if (!commit)
      throw new Error("Incremental operation log did not reach a commit");
    if (!state.matches(commit))
      throw new Error("Incremental LtHash verification failed");

    // A host can inline only values that are still current when it serves a
    // page. Keep applying every operation to RepoCommit above, but project only
    // the last operation for each path. Earlier value-less creates/updates are
    // thereby omitted only after a later operation confirms they were stale.
    const events: IngestEvent[] = [];
    const operations = [...finalProjectionOps.values()]
      .sort((left, right) => left.order - right.order)
      .map(({ operation }) => operation);
    for (const operation of operations) {
      if (operation.cid && operation.value === undefined) {
        throw new Error(
          "Current incremental operation omitted its record value",
        );
      }
      // A valid commit authenticates CIDs, not the inline values. Check these
      // before ingest can silently drop a bad value but commit its checkpoint,
      // even if application-level CID validation is disabled.
      if (operation.cid) {
        const serialized = await serializeRecord(
          operation.collection,
          operation.rkey,
          operation.value!,
        );
        if (!serialized.cid.equals(parseCid(operation.cid))) {
          throw new Error("Incremental record CID verification failed");
        }
      }
      const observedAt = Date.now() * 1000;
      const value = operation.cid
        ? (lexToJson(operation.value!) as Record<string, unknown>)
        : undefined;
      const event = createIngestEvent({
        uri: formatSpaceRecordUri({
          spaceUri: watch.spaceUri,
          writerDid: local.repoDid,
          collection: operation.collection,
          rkey: operation.rkey,
        }),
        did: local.repoDid,
        collection: operation.collection,
        rkey: operation.rkey,
        operation: operation.cid
          ? operation.prev
            ? "update"
            : "create"
          : "delete",
        cid: operation.cid,
        value,
        timeUs: recordTimeUs(
          operation.value,
          operation.collection,
          this.config.projection,
          observedAt,
        ),
        indexedAt: observedAt,
        source: {
          id: `space:${watch.spaceUri}:${watch.generation}`,
          revision: operation.rev,
          time_us: observedAt,
        },
      });
      if (value) {
        const failure = await validateCanonicalRecord(
          this.config.projection,
          event,
          value,
        );
        if (failure === "lexicon_validation") {
          // MAC, whole-repo LtHash and this value's CID are already verified.
          // Exclude an invalid current record instead of keeping its previous
          // valid value. Preserve the source CID/revision in the tombstone so
          // projection, derived state and checkpoint advance atomically.
          events.push({ ...event, operation: "delete", record: null });
          continue;
        }
        if (failure) {
          throw new Error(`Incremental record validation failed: ${failure}`);
        }
      }
      events.push(event);
    }
    await assertLease();
    const checkpoint = saveRepoStateStatement(this.db, {
      ...local,
      pdsUrl: writerPds,
      rev: commit.rev,
      ltHash: state.setHash.state(),
      commitHash: commit.data,
    });
    if (events.length) {
      await ingestRecords(this.db, events, this.config.projection, {
        projection: createIsolatedProjection({
          scope: this.scope(watch),
          partition: local.repoDid,
          generation: local.visibleWriterGeneration,
        }),
        trailingStatements: [checkpoint, ...fence()],
        skipDiagnostics: true,
      });
    } else {
      await this.db.batch([checkpoint, ...fence()]);
    }
  }

  private async verifiedOps(
    transport: SpaceCredentialTransport,
    writerPds: string,
    input: Parameters<typeof listRepoOps>[2],
    options: { signal?: AbortSignal },
  ): Promise<ListRepoOpsOutput> {
    const read = async (forceRefresh: boolean) => {
      const kemDidKey = await this.identities.resolveKemKey(
        input.repo,
        forceRefresh,
      );
      const endpoint = forceRefresh
        ? await this.identities.resolvePds(input.repo)
        : writerPds;
      const page = await listRepoOps(transport, endpoint, input, {
        ...options,
        kemDidKey,
      });
      if (
        page.commit &&
        (!page.mac ||
          !verifyCommit(page.commit, {
            space: input.space,
            repo: input.repo,
            sharedSecret: page.sharedSecret,
            mac: page.mac,
          }))
      )
        throw new Error("Incremental commit MAC verification failed");
      return page;
    };
    try {
      return await read(false);
    } catch (error) {
      if (options.signal?.aborted || error instanceof SpaceProtocolError)
        throw error;
      return read(true);
    }
  }

  private async recoverRepo(
    watch: SpaceWatch,
    repoDid: string,
    transport: SpaceCredentialTransport,
    assertLease: () => Promise<void>,
    fence: () => Statement[] = () => [],
  ): Promise<void> {
    const prior = await getRepoState(this.db, watch, repoDid);
    const writerGeneration = (prior?.visibleWriterGeneration ?? 0) + 1;
    let writerPds = await this.identities.resolvePds(repoDid);
    const recover = async (forceRefresh: boolean) => {
      const kemDidKey = await this.identities.resolveKemKey(
        repoDid,
        forceRefresh,
      );
      if (forceRefresh) writerPds = await this.identities.resolvePds(repoDid);
      const response = await getRepoStar(transport, writerPds, {
        space: watch.spaceUri,
        repo: repoDid,
        kemDidKey,
        maxBytes: this.config.maxRepoStarBytes,
      });
      return verifyRepoStarFull([response.bytes], {
        space: watch.spaceUri,
        repo: repoDid,
        sharedSecret: response.sharedSecret,
        mac: response.mac,
      });
    };
    let recovered;
    try {
      recovered = await recover(false);
    } catch (error) {
      if (
        error instanceof SpaceProtocolError &&
        (error.accessDenied ||
          error.deleted ||
          error.code === "CredentialExpired" ||
          error.code === "RepoTooLarge" ||
          error.code === "UpstreamTimeout" ||
          WRITER_UNAVAILABLE.has(error.code))
      )
        throw error;
      recovered = await recover(true);
    }
    const events: IngestEvent[] = [];
    const observedAt = Date.now() * 1000;
    for (const record of recovered.records) {
      if (!collectionAllowed(this.config, watch, record.collection)) continue;
      events.push(
        createIngestEvent({
          uri: formatSpaceRecordUri({
            spaceUri: watch.spaceUri,
            writerDid: repoDid,
            collection: record.collection,
            rkey: record.rkey,
          }),
          did: repoDid,
          collection: record.collection,
          rkey: record.rkey,
          operation: "create",
          cid: record.cid.toString(),
          value: lexToJson(record.record),
          timeUs: recordTimeUs(
            record.record,
            record.collection,
            this.config.projection,
            observedAt,
          ),
          indexedAt: observedAt,
          source: {
            id: `space:${watch.spaceUri}:${watch.generation}`,
            revision: recovered.commit.rev,
            time_us: observedAt,
          },
        }),
      );
    }

    const target = {
      scope: this.scope(watch),
      partition: repoDid,
      generation: writerGeneration,
    };
    await assertLease();
    await deleteIsolatedPartitionGeneration(this.db, this.config.projection, {
      ...target,
      trailingStatements: fence(),
    });
    const chunkSize = this.budget.recoveryBatchSize;
    for (let offset = 0; offset < events.length; offset += chunkSize) {
      await assertLease();
      const chunk = events.slice(offset, offset + chunkSize);
      await ingestRecords(this.db, chunk, this.config.projection, {
        projection: createIsolatedProjection(target),
        authoritativeSourceObservation: true,
        skipDiagnostics: true,
        trailingStatements: fence(),
      });
    }

    await assertLease();
    const checkpoint = saveRepoStateStatement(this.db, {
      spaceUri: watch.spaceUri,
      spaceGeneration: watch.generation,
      repoDid,
      pdsUrl: writerPds,
      visibleWriterGeneration: writerGeneration,
      rev: recovered.commit.rev,
      ltHash: RepoCommit.fromRecords(recovered.records).setHash.state(),
      commitHash: recovered.commit.data,
    });
    await this.db.batch([
      activateIsolatedPartitionStatement(this.db, {
        ...target,
        activate: true,
      }),
      ...rebuildIsolatedCountsStatements(
        this.db,
        this.config.projection,
        this.scope(watch),
      ),
      checkpoint,
      ...fence(),
    ]);
    if (prior && prior.visibleWriterGeneration !== writerGeneration) {
      await assertLease();
      await deleteIsolatedPartitionGeneration(this.db, this.config.projection, {
        scope: this.scope(watch),
        partition: repoDid,
        generation: prior.visibleWriterGeneration,
        trailingStatements: fence(),
      });
    }
  }

  private async deleteSpace(watch: SpaceWatch): Promise<void> {
    await hideDeletedSpace(this.db, watch);
    await purgeSpaceGeneration(this.db, this.config.projection, watch);
    await this.config.onInvalidate?.(watch.spaceUri);
  }

  private async removeWriter(
    watch: SpaceWatch,
    state: SpaceRepoState,
  ): Promise<void> {
    await this.db.batch([
      hideIsolatedPartitionStatement(this.db, this.scope(watch), state.repoDid),
      ...rebuildIsolatedCountsStatements(
        this.db,
        this.config.projection,
        this.scope(watch),
      ),
    ]);
    await deleteRepoState(this.db, watch, state.repoDid);
    await deleteIsolatedPartitionGeneration(this.db, this.config.projection, {
      scope: this.scope(watch),
      partition: state.repoDid,
      generation: state.visibleWriterGeneration,
    });
    await this.config.onInvalidate?.(watch.spaceUri);
  }
}
