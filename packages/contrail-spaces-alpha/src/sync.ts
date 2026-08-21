import { parseCid } from "@atproto/lex-data";
import {
  RepoCommit,
  verifyCommit,
  verifyRepoCarFull,
  type SignedCommit,
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
} from "@atmo-dev/contrail";
import {
  getRepoCar,
  getSpace,
  listRepoOps,
  listRepos,
  registerNotify,
  SpaceCredentialTransport,
  SpaceIdentityResolver,
  SpaceProtocolError,
  type ProtocolOptions,
  type SignedCommitInput,
} from "./protocol";
import {
  acquireSyncLease,
  deleteRepoState,
  getRepoState,
  getSpaceWatch,
  hideDeletedSpace,
  listDueWatches,
  listRepoStates,
  loadCredential,
  noteRepoOmissions,
  purgeSpaceGeneration,
  releaseSyncLease,
  renewSyncLease,
  saveRepoStateStatement,
  updateWatch,
  type SpaceRepoState,
  type SpaceWatch,
} from "./storage";
import { formatSpaceRecordUri, parseSpaceUri, spaceProjectionKey } from "./uri";

export type SpaceUserPolicy = "public" | "member-list" | "managing-app";

export interface SpaceTypeConfig {
  collections: readonly string[];
  skey?: string;
  /** User policy asserted against the authority PDS description. Defaults to
   * `managing-app` for backwards compatibility. */
  policy?: SpaceUserPolicy;
}

export interface SpacesSyncConfig {
  projection: ContrailConfig;
  spaceTypes: Record<string, SpaceTypeConfig>;
  serviceAudience: string;
  credentialEncryptionKey: string;
  reconcileIntervalMs?: number;
  registrationRenewalWindowMs?: number;
  /** Maximum mutations admitted with one verified incremental checkpoint.
   * Larger commits recover through a staged full CAR instead (default 10). */
  maxAtomicMutations?: number;
  /** Maximum complete repo CAR buffered by the Worker (default 16 MiB). */
  maxRepoCarBytes?: number;
  protocol?: ProtocolOptions;
  logger?: Pick<Console, "log" | "warn" | "error">;
  onInvalidate?: (spaceUri: string) => void | Promise<void>;
}

export interface ReconcileOptions {
  limit?: number;
  deadline?: number;
}

const SYNC_LEASE_TTL_MS = 90_000;

class SyncLeaseLostError extends Error {
  constructor() {
    super("Space repo sync lease was lost");
    this.name = "SyncLeaseLostError";
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function asSignedCommit(input: SignedCommitInput): SignedCommit {
  if (input.ver !== 1) throw new Error(`Unsupported Space commit version ${input.ver}`);
  return input as SignedCommit;
}

function collectionAllowed(
  config: SpacesSyncConfig,
  watch: SpaceWatch,
  collection: string,
): boolean {
  return config.spaceTypes[watch.spaceType]?.collections.includes(collection) ?? false;
}

export class SpacesSyncEngine {
  readonly identities: SpaceIdentityResolver;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(
    readonly db: Database,
    readonly config: SpacesSyncConfig,
  ) {
    this.identities = new SpaceIdentityResolver(config.protocol);
    this.logger = config.logger ?? console;
  }

  private scope(watch: SpaceWatch) {
    return {
      kind: "isolated" as const,
      key: spaceProjectionKey(watch.spaceUri, watch.generation),
    };
  }

  private async transport(watch: SpaceWatch): Promise<SpaceCredentialTransport> {
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
    return SpaceCredentialTransport.restore(
      stored.credential,
      this.config.protocol?.fetch,
    );
  }

  async validateWatch(
    watch: SpaceWatch,
    suppliedTransport?: SpaceCredentialTransport,
  ): Promise<void> {
    const transport = suppliedTransport ?? await this.transport(watch);
    const parsed = parseSpaceUri(watch.spaceUri);
    const type = this.config.spaceTypes[parsed.type];
    if (!type) throw new Error(`Unsupported Space type: ${parsed.type}`);
    if (type.skey !== undefined && parsed.skey !== type.skey) {
      throw new Error(`Unsupported Space key for ${parsed.type}`);
    }
    const authorityPds = await this.identities.resolvePds(parsed.authorityDid);
    const description = await getSpace(transport, authorityPds, watch.spaceUri);
    if (description.uri !== watch.spaceUri) {
      throw new Error("Space authority returned a different URI");
    }
    const expectedPolicy = type.policy ?? "managing-app";
    const expectedPolicyType = {
      public: "com.atproto.simplespace.defs#publicPolicy",
      "member-list": "com.atproto.simplespace.defs#memberListPolicy",
      "managing-app": "com.atproto.simplespace.defs#managingAppPolicy",
    }[expectedPolicy];
    if (description.policy?.$type !== expectedPolicyType) {
      throw new Error(`Space does not use the configured ${expectedPolicy} policy`);
    }
    if (expectedPolicy === "managing-app" &&
      description.policy.managingApp !== this.config.serviceAudience) {
      throw new Error("Space is managed by a different application");
    }
    if (
      description.appAccess?.$type !== undefined &&
      description.appAccess.$type !== "com.atproto.simplespace.defs#open"
    ) {
      throw new Error("The first Spaces-alpha provider supports only open appAccess");
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
        this.logger.error(`[spaces] reconciliation failed for ${watch.spaceUri}`, error);
      }
    }
    return completed;
  }

  async reconcileSpace(
    spaceUri: string,
    options: { deadline?: number; preferredRepo?: string } = {},
  ): Promise<void> {
    const watch = await getSpaceWatch(this.db, spaceUri);
    if (!watch || watch.status === "hidden") return;
    const deadline = options.deadline ?? Date.now() + 25_000;
    try {
      const transport = await this.transport(watch);
      await this.validateWatch(watch, transport);
      const authorityPds = await this.identities.resolvePds(watch.authorityDid);
      const renewalWindow = this.config.registrationRenewalWindowMs ?? 60 * 60_000;
      if (
        !watch.registrationExpiresAt ||
        Date.parse(watch.registrationExpiresAt) - Date.now() < renewalWindow
      ) {
        const registration = await registerNotify(transport, authorityPds, {
          space: watch.spaceUri,
          service: this.config.serviceAudience,
        });
        await updateWatch(this.db, watch.spaceUri, {
          registrationExpiresAt: registration.expiresAt,
          expectedGeneration: watch.generation,
        });
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
          if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(repo.did) ||
            !repo.rev || !(repo.hash instanceof Uint8Array) ||
            repo.hash.byteLength !== 32) {
            throw new Error("Space authority returned an invalid writer entry");
          }
          advertised.set(repo.did, { rev: repo.rev, hash: repo.hash });
        }
        cursor = page.cursor;
      } while (cursor && Date.now() < deadline);
      if (cursor) throw new Error("Reconciliation deadline reached during writer listing");

      const local = new Map(
        (await listRepoStates(this.db, watch)).map((state) => [state.repoDid, state]),
      );
      const advertisedEntries = [...advertised];
      if (options.preferredRepo && advertised.has(options.preferredRepo)) {
        advertisedEntries.sort(([left], [right]) =>
          left === options.preferredRepo ? -1 : right === options.preferredRepo ? 1 : 0);
      }
      for (const [repoDid, remote] of advertisedEntries) {
        if (Date.now() >= deadline) break;
        const state = local.get(repoDid);
        if (!state || state.rev !== remote.rev || !bytesEqual(state.commitHash, remote.hash)) {
          await this.syncRepo(watch.spaceUri, repoDid);
        }
      }

      // One stale authority omission cannot erase a verified writer. Two
      // complete reconciliations are the deliberately conservative v1 evidence.
      const removed = await noteRepoOmissions(this.db, watch, new Set(advertised.keys()));
      for (const state of removed) await this.removeWriter(watch, state);

      const now = Date.now();
      await updateWatch(this.db, watch.spaceUri, {
        status: "active",
        error: null,
        reconciledAt: now,
        nextReconcileAt: now + (this.config.reconcileIntervalMs ?? 5 * 60_000),
        expectedGeneration: watch.generation,
      });
    } catch (error) {
      if (error instanceof SpaceProtocolError && error.deleted) {
        await this.deleteSpace(watch);
        return;
      }
      const paused = error instanceof SpaceProtocolError &&
        (error.accessDenied || error.code === "CredentialExpired");
      await updateWatch(this.db, watch.spaceUri, {
        status: paused ? "paused" : watch.status,
        error: error instanceof Error ? error.message.slice(0, 500) : "Sync failed",
        nextReconcileAt: Date.now() + 60_000,
        expectedGeneration: watch.generation,
      });
      throw error;
    }
  }

  async syncRepo(
    spaceUri: string,
    repoDid: string,
    advertised?: { rev?: string; hash?: Uint8Array },
  ): Promise<void> {
    const watch = await getSpaceWatch(this.db, spaceUri);
    if (!watch || watch.status === "hidden") return;
    const owner = crypto.randomUUID();
    if (!await acquireSyncLease(this.db, {
      spaceUri,
      generation: watch.generation,
      repoDid,
      owner,
      ttlMs: SYNC_LEASE_TTL_MS,
    })) return;
    // Every durable stage renews this owner token first. Work may outlive the
    // original TTL while downloading/verifying, but a worker that loses the
    // lease is fenced before it can resume projection or checkpoint writes.
    const assertLease = async (): Promise<void> => {
      if (!await renewSyncLease(this.db, {
        spaceUri,
        generation: watch.generation,
        repoDid,
        owner,
        ttlMs: SYNC_LEASE_TTL_MS,
      })) {
        throw new SyncLeaseLostError();
      }
    };
    try {
      const currentWatch = await getSpaceWatch(this.db, spaceUri);
      if (!currentWatch || currentWatch.generation !== watch.generation ||
        currentWatch.status === "hidden") return;
      const transport = await this.transport(watch);
      await assertLease();
      const state = await getRepoState(this.db, watch, repoDid);
      if (!state) {
        await this.recoverRepo(watch, repoDid, transport, assertLease);
      } else {
        try {
          await this.incrementalRepo(watch, state, transport, assertLease);
        } catch (error) {
          if (error instanceof SyncLeaseLostError) throw error;
          this.logger.warn(
            `[spaces] incremental sync fell back to recovery for ${spaceUri} ${repoDid}`,
            error,
          );
          await this.recoverRepo(watch, repoDid, transport, assertLease);
        }
      }
      if (advertised?.hash) {
        const updated = await getRepoState(this.db, watch, repoDid);
        if (updated && advertised.rev === updated.rev &&
          !bytesEqual(updated.commitHash, advertised.hash)) {
          throw new Error("Synchronized commit did not match notification target hash");
        }
      }
      await this.config.onInvalidate?.(spaceUri);
    } catch (error) {
      if (error instanceof SpaceProtocolError && error.deleted) {
        await assertLease();
        await this.deleteSpace(watch);
      } else {
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
  ): Promise<void> {
    const writerPds = await this.identities.resolvePds(local.repoDid);
    const state = RepoCommit.fromState(local.ltHash);
    const events: IngestEvent[] = [];
    let cursor: string | undefined;
    let commit: SignedCommit | undefined;
    do {
      const page = await listRepoOps(transport, writerPds, {
        space: watch.spaceUri,
        repo: local.repoDid,
        since: local.rev,
        cursor,
        limit: 1000,
      });
      for (const operation of page.ops) {
        state.applyOp({
          collection: operation.collection,
          rkey: operation.rkey,
          cid: operation.cid ? parseCid(operation.cid) : null,
          prev: operation.prev ? parseCid(operation.prev) : null,
        });
        if (!collectionAllowed(this.config, watch, operation.collection)) continue;
        if (operation.cid && operation.value === undefined) {
          throw new Error("Incremental operation omitted its record value");
        }
        const observedAt = Date.now() * 1000;
        events.push(createIngestEvent({
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
          value: operation.value,
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
        }));
        if (events.length > (this.config.maxAtomicMutations ?? 10)) {
          throw new Error("Incremental commit exceeds the bounded atomic mutation limit");
        }
      }
      cursor = page.cursor;
      if (page.commit) commit = asSignedCommit(page.commit);
    } while (cursor);
    if (!commit) throw new Error("Incremental operation log did not reach a commit");
    const key = await this.identities.resolveSigningKey(local.repoDid);
    const valid = await verifyCommit(
      commit,
      { space: watch.spaceUri, author: local.repoDid, rev: commit.rev },
      key,
    );
    if (!valid || !state.matches(commit)) {
      // Retry key rotation once before forcing a full recovery.
      const refreshed = await this.identities.resolveSigningKey(local.repoDid, true);
      const refreshedValid = await verifyCommit(
        commit,
        { space: watch.spaceUri, author: local.repoDid, rev: commit.rev },
        refreshed,
      );
      if (!refreshedValid || !state.matches(commit)) {
        throw new Error("Incremental commit signature or LtHash verification failed");
      }
    }
    if (events.length > (this.config.maxAtomicMutations ?? 10)) {
      throw new Error("Incremental commit exceeds the bounded atomic mutation limit");
    }
    await assertLease();
    const checkpoint = saveRepoStateStatement(this.db, {
      ...local,
      pdsUrl: writerPds,
      rev: commit.rev,
      ltHash: state.setHash.state(),
      commitHash: commit.hash,
      removalObservations: 0,
    });
    if (events.length) {
      await ingestRecords(this.db, events, this.config.projection, {
        projection: createIsolatedProjection({
          scope: this.scope(watch),
          partition: local.repoDid,
          generation: local.visibleWriterGeneration,
        }),
        trailingStatements: [checkpoint],
        skipDiagnostics: true,
      });
    } else {
      await this.db.batch([checkpoint]);
    }
  }

  private async recoverRepo(
    watch: SpaceWatch,
    repoDid: string,
    transport: SpaceCredentialTransport,
    assertLease: () => Promise<void>,
  ): Promise<void> {
    const prior = await getRepoState(this.db, watch, repoDid);
    const writerGeneration = (prior?.visibleWriterGeneration ?? 0) + 1;
    const writerPds = await this.identities.resolvePds(repoDid);
    const bytes = await getRepoCar(transport, writerPds, {
      space: watch.spaceUri,
      repo: repoDid,
      maxBytes: this.config.maxRepoCarBytes,
    });
    const key = await this.identities.resolveSigningKey(repoDid);
    let recovered;
    try {
      recovered = await verifyRepoCarFull(
        [bytes],
        { space: watch.spaceUri, author: repoDid, didKey: key },
      );
    } catch {
      const refreshed = await this.identities.resolveSigningKey(repoDid, true);
      recovered = await verifyRepoCarFull(
        [bytes],
        { space: watch.spaceUri, author: repoDid, didKey: refreshed },
      );
    }
    const events: IngestEvent[] = [];
    const observedAt = Date.now() * 1000;
    for (const record of recovered.records) {
      if (!collectionAllowed(this.config, watch, record.collection)) continue;
      events.push(createIngestEvent({
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
        value: record.record,
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
      }));
    }

    const target = {
      scope: this.scope(watch),
      partition: repoDid,
      generation: writerGeneration,
    };
    await assertLease();
    await deleteIsolatedPartitionGeneration(this.db, this.config.projection, target);
    const chunkSize = this.config.maxAtomicMutations ?? 10;
    for (let offset = 0; offset < events.length; offset += chunkSize) {
      await assertLease();
      const chunk = events.slice(offset, offset + chunkSize);
      await ingestRecords(
        this.db,
        chunk,
        this.config.projection,
        {
          projection: createIsolatedProjection(target),
          authoritativeSourceObservation: true,
          skipDiagnostics: true,
        },
      );
    }

    await assertLease();
    const checkpoint = saveRepoStateStatement(this.db, {
      spaceUri: watch.spaceUri,
      spaceGeneration: watch.generation,
      repoDid,
      pdsUrl: writerPds,
      visibleWriterGeneration: writerGeneration,
      rev: recovered.commit.rev,
      ltHash: recovered.repo.setHash.state(),
      commitHash: recovered.commit.hash,
      removalObservations: 0,
    });
    await this.db.batch([
      activateIsolatedPartitionStatement(this.db, { ...target, activate: true }),
      ...rebuildIsolatedCountsStatements(
        this.db,
        this.config.projection,
        this.scope(watch),
      ),
      checkpoint,
    ]);
    if (prior && prior.visibleWriterGeneration !== writerGeneration) {
      await assertLease();
      await deleteIsolatedPartitionGeneration(this.db, this.config.projection, {
        scope: this.scope(watch),
        partition: repoDid,
        generation: prior.visibleWriterGeneration,
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
