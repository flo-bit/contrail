import assert from "node:assert/strict";
import { createPublicServiceClient } from "../dist/public-client.js";

const client = createPublicServiceClient({
  endpoint: "https://api.example.com",
  fetch: async () => Response.json({ records: [] }),
});
const response = await client.get("com.example.listRecords");
assert.equal(response.ok, true);
assert.deepEqual(response.data, { records: [] });
console.log("built public client passed");
