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
