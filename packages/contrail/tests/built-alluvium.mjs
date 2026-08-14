import assert from "node:assert/strict";
import {
  AlluviumChangeSource,
  AlluviumSnapshotSource,
  createAlluviumBootstrapSources,
  createAlluviumLiveCursor,
} from "@atmo-dev/contrail/alluvium";

assert.equal(typeof AlluviumSnapshotSource, "function");
assert.equal(typeof AlluviumChangeSource, "function");
assert.equal(typeof createAlluviumBootstrapSources, "function");
assert.equal(typeof createAlluviumLiveCursor, "function");
console.log("built Alluvium adapter passed");
