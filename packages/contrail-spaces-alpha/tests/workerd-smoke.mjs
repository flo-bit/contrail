import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const state = await mkdtemp(resolve(tmpdir(), "contrail-spaces-workerd-"));
async function port() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
const httpPort = await port();
const child = spawn(
  resolve(root, "node_modules/.bin/wrangler"),
  [
    "dev",
    "--local",
    "--config",
    "tests/workerd/wrangler.jsonc",
    "--port",
    String(httpPort),
    "--inspector-port",
    String(await port()),
    "--persist-to",
    state,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
}
try {
  const deadline = Date.now() + 40_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Wrangler exited with ${child.exitCode}`);
    try {
      response = await fetch(`http://127.0.0.1:${httpPort}/probe`, {
        signal: AbortSignal.timeout(2_000),
      });
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  assert(response, "Wrangler startup timed out");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    star: true,
    policy: true,
    signature: true,
    privateD1: true,
  });
  console.log(
    "workerd passed: P-256/KEM, tagged HTTP signatures, published-policy verification, STAR/MAC verification, isolated D1 initialization",
  );
} catch (error) {
  console.error(error);
  console.error(output.slice(-20_000));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(state, { recursive: true, force: true });
}
