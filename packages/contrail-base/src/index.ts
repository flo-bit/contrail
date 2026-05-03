/** @atmo-dev/contrail-base — shared infrastructure for the contrail family.
 *
 *  No routes. No tables of its own. Pure types, interfaces, primitives, and
 *  shared utilities used across contrail / contrail-appview / contrail-authority /
 *  contrail-record-host / contrail-community.
 *
 *  Re-exported wholesale from each source module — anything internal that
 *  needed to be hidden would have an explicit subpath export instead. */

// Core types + config + helpers (Database, ContrailConfig, dialect helpers, etc.)
export * from "./types";

// Dialect (SqlDialect, getDialect, sqliteDialect, postgresDialect, buildFtsSchema)
export * from "./dialect";

// Identity (resolveActor, resolveIdentities, refreshStaleIdentities)
export * from "./identity";

// PDS client helpers (getPDS, getClient)
export * from "./client";

// Spaces interfaces + shared types
export * from "./spaces/types";

// Spaces URI helpers
export * from "./spaces/uri";

// TID generator
export * from "./spaces/tid";

// In-process auth marker
export * from "./spaces/in-process";

// Service-auth verification
export * from "./spaces/auth";

// ACL pure functions
export * from "./spaces/acl";

// Credentials
export * from "./spaces/credentials";

// Membership manifests
export * from "./spaces/manifest";

// Binding + key resolution
export * from "./spaces/binding";

// Blob adapter interface + built-in impls
export * from "./spaces/blob-adapter";

// Invite token primitives + community-handler interface
export * from "./invite/token";
export * from "./invite/community-handler";

// Community integration interface + WhoamiExtension
export * from "./community-integration";

// Labels types
export * from "./labels/types";

// Realtime infrastructure
export * from "./realtime/types";
export * from "./realtime/in-memory";
export * from "./realtime/ticket";
export * from "./realtime/durable-object";
export * from "./realtime/sse";
export * from "./realtime/websocket";
export * from "./realtime/merge";
export * from "./realtime/query-filter";
