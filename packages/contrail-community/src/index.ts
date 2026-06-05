export { registerCommunityRoutes } from "./router";
export type { CommunityRoutesOptions } from "./router";
export { CommunityAdapter } from "./adapter";
export type {
  AccessLevel,
  AccessLevelRow,
  CommunityConfig,
  CommunityInviteRow,
  CommunityMode,
  CommunityRow,
  CreateCommunityInviteInput,
  ReservedKey,
} from "./types";
export {
  ACCESS_LEVELS,
  RESERVED_KEYS,
  isAccessLevel,
  isReservedKey,
  rankOf,
} from "./types";
export { CredentialCipher } from "./credentials";
export { resolveEffectiveLevel, flattenEffectiveMembers, wouldCycle } from "./acl";
export { reconcile } from "./reconcile";
export { createCommunityInviteHandler } from "./invite-handler";
export { createCommunityWhoamiExtension } from "./whoami";
export { initCommunitySchema, buildCommunitySchema } from "./schema";
export {
  resolveIdentity,
  createPdsSession,
  pdsCreateAccount,
  pdsGetRecommendedDidCredentials,
  pdsActivateAccount,
  pdsCreateAppPassword,
} from "./pds";
export type {
  PdsCreateAccountBody,
  PdsCreateAccountResult,
  RecommendedDidCredentials,
} from "./pds";
export {
  generateKeyPair,
  buildGenesisOp,
  signGenesisOp,
  computeDidPlc,
  submitGenesisOp,
  encodeDagCbor,
  jwkToDidKey,
  buildUpdateOp,
  signUpdateOp,
  cidForOp,
  getLastOpCid,
  buildTombstoneOp,
  signTombstoneOp,
  submitTombstoneOp,
} from "./plc";
export type {
  KeyPair,
  GenesisOpInput,
  UnsignedGenesisOp,
  SignedGenesisOp,
  UpdateOpInput,
  UnsignedUpdateOp,
  SignedUpdateOp,
  UnsignedTombstoneOp,
  SignedTombstoneOp,
} from "./plc";

// The headline export — wire community into a contrail app via:
//   const community = createCommunityIntegration({ db, config });
//   const app = createApp(db, config, { community });
export { createCommunityIntegration } from "./integration";
export type { CommunityIntegrationOptions } from "./integration";

export { ProvisionOrchestrator } from "./provision";
export type {
  PdsClient,
  PlcClient,
  ProvisionInput,
  ProvisionResult,
  ProvisionOrchestratorDeps,
} from "./provision";

export { registerReap, runReap } from "./cli/reap";
export type {
  ReapLogger,
  ReapHostDeps,
  RunReapOptions,
  RunReapResult,
} from "./cli/reap";
