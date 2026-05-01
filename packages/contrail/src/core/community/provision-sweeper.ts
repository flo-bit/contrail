/** Recovery sweeper for stuck provision attempts.
 *
 *  Walks `provision_attempts` rows in `genesis_submitted` status that haven't
 *  advanced for at least `stuckMs`, and probes the PDS via createSession:
 *    - 401  → account never reached the PDS (or has been wiped) → mark orphaned
 *    - 200  → account exists (deactivated or active); we have an accessJwt →
 *             advance to `account_created` and hand off to the orchestrator
 *             to drive steps 4-5 to completion.
 *
 *  Q4 verified: a deactivated atproto account returns HTTP 200 with
 *  `active: false, status: "deactivated"`, so the same probe distinguishes
 *  "account missing" from "account stuck mid-provisioning".
 */

import type { CommunityAdapter } from "./adapter";
import type { CredentialCipher } from "./credentials";
import type { PdsCreateSessionResult } from "./pds";

export interface SweeperPdsClient {
  /** Resolve a session against a PDS, returning null on 401 (account not
   *  present) and the full result otherwise. The sweeper relies on this
   *  null-vs-result split — implementations should NOT throw on 401. */
  createSession(input: {
    pdsUrl: string;
    identifier: string;
    password: string;
  }): Promise<PdsCreateSessionResult | null>;
}

export interface SweeperOrchestrator {
  resumeFromAccountCreated(attemptId: string, accessJwt: string): Promise<void>;
}

export interface ProvisionSweeperDeps {
  adapter: CommunityAdapter;
  cipher: CredentialCipher;
  pds: SweeperPdsClient;
  orchestrator: SweeperOrchestrator;
}

export class ProvisionSweeper {
  constructor(private deps: ProvisionSweeperDeps) {}

  /** Walk `genesis_submitted` rows older than `stuckMs` and probe each one. */
  async sweep(opts: { stuckMs: number }): Promise<void> {
    const stuck = await this.deps.adapter.listProvisionAttemptsByStatus(
      "genesis_submitted",
      opts.stuckMs
    );
    for (const row of stuck) {
      if (!row.encryptedPassword) {
        await this.deps.adapter.updateProvisionStatus(
          row.attemptId,
          "orphaned",
          { lastError: "no encrypted password to probe with" }
        );
        continue;
      }
      const password = await this.deps.cipher.decryptString(
        row.encryptedPassword
      );
      const session = await this.deps.pds.createSession({
        pdsUrl: row.pdsEndpoint,
        identifier: row.handle,
        password,
      });
      if (!session) {
        await this.deps.adapter.updateProvisionStatus(
          row.attemptId,
          "orphaned",
          { lastError: "createSession 401 — account not present on PDS" }
        );
        continue;
      }
      // Account exists. Whether deactivated or active, we have an accessJwt — resume.
      await this.deps.adapter.updateProvisionStatus(
        row.attemptId,
        "account_created"
      );
      await this.deps.orchestrator.resumeFromAccountCreated(
        row.attemptId,
        session.accessJwt
      );
    }
  }
}
