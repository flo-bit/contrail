/** Baseline wire policies. The PDS owns defaults, membership and enforcement. */
export interface MemberspacePolicy {
  $type: "com.atproto.memberspace.policy";
  publicRead?: boolean;
  publicWrite?: boolean;
  allowedApps?: string[];
  publishPolicy?: boolean;
  publishMembers?: boolean;
}

export interface ManagedspacePolicy {
  $type: "com.atproto.managedspace.policy";
  managingApp: string;
  publishPolicy?: boolean;
}

export type SyncedSpacePolicy = MemberspacePolicy | ManagedspacePolicy;

/** Configuration-only marker for Space types whose authority host decides
 * access by itself, such as a group host that is its own managing app. It is
 * never sent to a PDS. The authority issuing a credential for a user's
 * delegation is the only access assertion: no published policy is read, and
 * this service is never asked `checkUserAccess`. Use it only for authorities
 * the application trusts to enforce their own access rules. */
export interface AuthorityDecidedPolicy {
  $type: "authority";
}

export type SpaceTypePolicy = SyncedSpacePolicy | AuthorityDecidedPolicy;

export function isAuthorityDecidedPolicy(
  value: unknown,
): value is AuthorityDecidedPolicy {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).$type === "authority" &&
    Object.keys(value).length === 1
  );
}
export type SpacePolicy =
  | { $type: "com.atproto.personalspace.policy" }
  | SyncedSpacePolicy;

/** Validate policy shapes at the runtime configuration and record boundaries. */
export function isSyncedSpacePolicy(
  value: unknown,
): value is SyncedSpacePolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  const boolean = (key: string) =>
    policy[key] === undefined || typeof policy[key] === "boolean";
  if (!boolean("publishPolicy")) return false;
  if (policy.$type === "com.atproto.managedspace.policy") {
    return (
      typeof policy.managingApp === "string" &&
      /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+)?$/.test(
        policy.managingApp,
      )
    );
  }
  return (
    policy.$type === "com.atproto.memberspace.policy" &&
    boolean("publicRead") &&
    boolean("publicWrite") &&
    boolean("publishMembers") &&
    (policy.allowedApps === undefined ||
      (Array.isArray(policy.allowedApps) &&
        policy.allowedApps.every((app) => typeof app === "string")))
  );
}
