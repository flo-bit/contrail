// Local-only workerd/D1 verification; no live PDS, relay or production database.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

async function availablePort() {
  const server = createServer();
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const { port } = server.address();
  await new Promise((closed) => server.close(closed));
  return port;
}

const root = resolve(import.meta.dirname, "..");
const stateDir = await mkdtemp(
  resolve(tmpdir(), "contrail-profile-read-smoke-"),
);
const port = await availablePort();
const inspectorPort = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(
  resolve(root, "node_modules/.bin/wrangler"),
  [
    "dev",
    "--config",
    "tests/workerd/profiles.wrangler.jsonc",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    "--persist-to",
    stateDir,
  ],
  {
    cwd: root,
    env: { ...process.env, CI: "true", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
child.on("error", (error) => {
  output += String(error);
});

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(`Wrangler exited: ${child.exitCode}`);
    try {
      ready = (
        await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
      ).ok;
      if (ready) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error("Wrangler startup timed out");
  const response = await fetch(`${origin}/run`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Profile smoke failed (${response.status}): ${await response.text()}`,
    );
  console.log(
    "workerd profile reads passed:",
    JSON.stringify(await response.json()),
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
      new Promise((done) => setTimeout(done, 5000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(stateDir, { recursive: true, force: true });
}
