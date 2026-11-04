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
  type ContrailConfig,
  type Database,
  type IngestEvent,
  type Statement,
} from "@atmo-dev/contrail";
import {
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
  deleteRepoState,
  getRepoState,
  getSpaceWatch,
  hideDeletedSpace,
  invalidateRevokedCredential,
  listDueWatches,
  listRepoStates,
  loadCredential,
  purgeSpaceGeneration,
  releaseSyncLease,
  renewSyncLease,
  saveRepoStateStatement,
  syncLeaseFenceStatements,
  updateWatch,
  type SpaceRepoState,
  type SpaceWatch,
} from "./storage";
import { formatSpaceRecordUri, parseSpaceUri, spaceProjectionKey } from "./uri";

import { isSyncedSpacePolicy, type SyncedSpacePolicy } from "./policy";

export interface SpaceTypeConfig {
  collections: readonly string[];
  skey?: string;
  /** Access configuration asserted against the authority's authenticated policy
   * record. The owner must enable publishPolicy on the PDS. */
  policy: SyncedSpacePolicy;
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
  maxIncrementalOperations: 10,
  recoveryBatchSize: 50,
}) satisfies SpacesSyncBudget;

function boundedSyncInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new TypeError(`${label} must be an integer from 1 through 50`);
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
    ),
    recoveryBatchSize: boundedSyncInteger(
      value.recoveryBatchSize ?? DEFAULT_SPACES_SYNC_BUDGET.recoveryBatchSize,
      "syncBudget.recoveryBatchSize",
    ),
  };
}

export interface SpacesSyncConfig {
  projection: ContrailConfig;
  spaceTypes: Record<string, SpaceTypeConfig>;
  serviceAudience: string;
  credentialEncryptionKey: string;
  reconcileIntervalMs?: number;
  notificationRegistration?: "required" | "best-effort" | "disabled";
  registrationRenewalWindowMs?: number;
  syncBudget?: SpacesSyncBudgetOptions;
  /** Maximum complete STAR archive buffered by the Worker (default 16 MiB). */
  maxRepoStarBytes?: number;
  protocol?: ProtocolOptions;
  logger?: Pick<Console, "log" | "warn" | "error">;
  onInvalidate?: (spaceUri: string) => void | Promise<void>;
}

export interface ReconcileOptions {
  limit?: number;
  deadline?: number;
}

const SYNC_LEASE_TTL_MS = 90_000;

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
    const stored = await loadCredential(this.db, {
      spaceUri: watch.spaceUri,
      generation: watch.generation,
      encryptionKey: this.config.credentialEncryptionKey,
    });
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
    options: { deadline?: number; preferredRepo?: string } = {},
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

      const advertised = new Map<string, { rev: string; hash: Uint8Array }>();
      let cursor: string | undefined;
      do {
        const page = await listRepos(transport, authorityPds, {
          space: watch.spaceUri,
          limit: 1000,
          cursor,
        });
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
          advertised.set(repo.did, { rev: repo.repoRev, hash: repo.data });
        }
        if (page.cursor && page.cursor === cursor)
          throw new Error("Writer listing cursor did not advance");
        cursor = page.repos.length ? page.cursor : undefined;
      } while (cursor && Date.now() < deadline);
      if (cursor)
        throw new Error(
          "Reconciliation deadline reached during writer listing",
        );

      const local = new Map(
        (await listRepoStates(this.db, watch)).map((state) => [
          state.repoDid,
          state,
        ]),
      );
      const advertisedEntries = [...advertised];
      if (options.preferredRepo && advertised.has(options.preferredRepo)) {
        advertisedEntries.sort(([left], [right]) =>
          left === options.preferredRepo
            ? -1
            : right === options.preferredRepo
              ? 1
              : 0,
        );
      }
      for (const [repoDid, remote] of advertisedEntries) {
        if (Date.now() >= deadline) break;
        const state = local.get(repoDid);
        if (
          !state ||
          state.rev !== remote.rev ||
          !bytesEqual(state.commitHash, remote.hash)
        ) {
          await this.syncRepo(watch.spaceUri, repoDid, undefined, { deadline });
        }
      }

      // Omission in a latest-state listing does not prove writer removal.
      // Keep verified records until authoritative deletion evidence arrives.

      const now = Date.now();
      await updateWatch(this.db, watch.spaceUri, {
        status: "active",
        error: null,
        reconciledAt: now,
        nextReconcileAt: now + (this.config.reconcileIntervalMs ?? 5 * 60_000),
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
      await updateWatch(this.db, watch.spaceUri, {
        status: paused ? "paused" : watch.status,
        error:
          error instanceof Error ? error.message.slice(0, 500) : "Sync failed",
        nextReconcileAt: Date.now() + 60_000,
        expectedGeneration: watch.generation,
        expectedStatus: "active",
      });
      throw error;
    }
  }

  async syncRepo(
    spaceUri: string,
    repoDid: string,
    advertised?: { rev?: string; hash?: Uint8Array },
    options: { deadline?: number } = {},
  ): Promise<void> {
    const watch = await getSpaceWatch(this.db, spaceUri);
    if (!watch || watch.status !== "active") return;
    const owner = crypto.randomUUID();
    if (
      !(await acquireSyncLease(this.db, {
        spaceUri,
        generation: watch.generation,
        repoDid,
        owner,
        ttlMs: SYNC_LEASE_TTL_MS,
      }))
    )
      return;
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
    try {
      const currentWatch = await getSpaceWatch(this.db, spaceUri);
      if (
        !currentWatch ||
        currentWatch.generation !== watch.generation ||
        currentWatch.status !== "active"
      )
        return;
      credential = await this.transport(watch);
      const { transport } = credential;
      await assertLease();
      const state = await getRepoState(this.db, watch, repoDid);
      if (!state) {
        await this.recoverRepo(watch, repoDid, transport, assertLease, fence);
      } else {
        try {
          await this.incrementalRepo(
            watch,
            state,
            transport,
            assertLease,
            options.deadline,
            fence,
          );
        } catch (error) {
          if (
            error instanceof SyncLeaseLostError ||
            error instanceof SyncDeadlineExceededError ||
            (error instanceof SpaceProtocolError &&
              (error.accessDenied ||
                error.deleted ||
                error.code === "CredentialExpired"))
          )
            throw error;
          this.logger.warn(
            `[spaces] incremental sync fell back to recovery for ${spaceUri} ${repoDid}`,
            error,
          );
          await this.recoverRepo(watch, repoDid, transport, assertLease, fence);
        }
      }
      if (advertised?.hash) {
        const updated = await getRepoState(this.db, watch, repoDid);
        if (
          updated &&
          advertised.rev === updated.rev &&
          !bytesEqual(updated.commitHash, advertised.hash)
        ) {
          throw new Error(
            "Synchronized commit did not match notification target hash",
          );
        }
      }
      await this.config.onInvalidate?.(spaceUri);
    } catch (error) {
      if (error instanceof SpaceProtocolError && error.deleted) {
        await assertLease();
        await this.deleteSpace(watch);
      } else {
        await this.invalidateRevoked(watch, credential, error);
        throw error;
      }
    } finally {
      await releaseSyncLease(this.db, {
        spaceUri,
        generation: watch.generation,
        repoDid,
        owner,
      });
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
      events.push(
        createIngestEvent({
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
          value: operation.cid ? lexToJson(operation.value!) : undefined,
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
        }),
      );
    }
    await assertLease();
    const checkpoint = saveRepoStateStatement(this.db, {
      ...local,
      pdsUrl: writerPds,
      rev: commit.rev,
      ltHash: state.setHash.state(),
      commitHash: commit.data,
      removalObservations: 0,
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
          error.code === "RepoTooLarge")
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
      removalObservations: 0,
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
