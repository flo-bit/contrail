import assert from "node:assert/strict";
import { createPublicServiceClient } from "../dist/public-client.js";

const client = createPublicServiceClient({
  endpoint: "https://api.example.com",
  serviceDid: "did:web:api.example.com",
  serviceAudience: "did:web:api.example.com#contrail",
  scope:
    "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed",
  protectedMethods: ["com.example.getFeed"],
  serviceMethods: ["com.example.listRecords", "com.example.getFeed"],
  collections: ["community.example.event"],
  fetch: async () => Response.json({ records: [] }),
});
assert.equal(client.endpoint, "https://api.example.com");
assert.equal(
  client.scope,
  "rpc?aud=did:web:api.example.com%23contrail&lxm=com.example.getFeed",
);
assert.deepEqual(client.collections, ["community.example.event"]);
const response = await client.get("com.example.listRecords");
assert.equal(response.ok, true);
assert.deepEqual(response.data, { records: [] });
console.log("built public client passed");
