import assert from "node:assert/strict";
import {
  DEFAULT_ALLUVIUM_ENDPOINT,
  SourceHistoryExpiredError,
  getAlluviumBootstrapState,
  loadAlluviumExport,
} from "@atmo-dev/contrail/alluvium";

assert.equal(typeof DEFAULT_ALLUVIUM_ENDPOINT, "string");
assert.equal(typeof SourceHistoryExpiredError, "function");
assert.equal(typeof getAlluviumBootstrapState, "function");
assert.equal(typeof loadAlluviumExport, "function");
console.log("built Alluvium adapter passed");
