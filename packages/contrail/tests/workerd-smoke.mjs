import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const STATE_DIR = await mkdtemp(
  resolve(tmpdir(), "contrail-workerd-runtime-smoke-"),
);
const MARKER = "[ingest] cycle summary ";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

async function availablePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  if (port === null) throw new Error("Could not allocate a local port");
  return port;
}

const port = await availablePort();
const inspectorPort = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const wrangler = resolve(PACKAGE_ROOT, "node_modules/.bin/wrangler");
let output = "";

const child = spawn(
  wrangler,
  [
    "dev",
    "--config",
    "tests/workerd/wrangler.jsonc",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    "--test-scheduled",
    "--persist-to",
    STATE_DIR,
    "--log-level",
    "log",
  ],
  {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, CI: "true", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

function summaries() {
  const parsed = [];
  for (const line of output.replace(ANSI, "").split("\n")) {
    const marker = line.indexOf(MARKER);
    if (marker === -1) continue;
    try {
      parsed.push(JSON.parse(line.slice(marker + MARKER.length)));
    } catch {
      // Ignore a line while Wrangler is still streaming it.
    }
  }
  return parsed;
}

async function state() {
  const response = await fetch(`${origin}/__contrail_workerd_smoke`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`Smoke state endpoint returned ${response.status}`);
  }
  return response.json();
}

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited early with code ${child.exitCode}`);
    }
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`,
  );
}

async function triggerScheduled() {
  const response = await fetch(`${origin}/__scheduled`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Scheduled trigger returned ${response.status}`);
  }
}

async function advanceCursor(predicate, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await triggerScheduled();
    try {
      return await waitFor(state, predicate, label, 20_000);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  throw new Error(`Could not ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stopWrangler() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

try {
  const initial = await waitFor(state, () => true, "Wrangler startup");
  assert(
    initial.cpuUsage?.exposed === true && initial.cpuUsage?.throws === true,
    `Expected workerd to expose a throwing process.cpuUsage stub, got ${JSON.stringify(initial.cpuUsage)}`,
  );

  const first = await advanceCursor(
    (value) => value.cursorDomain === "seq",
    "the timestamp bridge to commit a sequence cursor",
  );
  assert(
    Number.isSafeInteger(first.cursor) && first.cursor >= 0,
    `Invalid first sequence cursor: ${first.cursor}`,
  );

  const second = await advanceCursor(
    (value) =>
      value.cursorDomain === "seq" &&
      Number.isSafeInteger(value.cursor) &&
      value.cursor > first.cursor,
    "an existing sequence cursor to pass preflight and advance",
  );

  await waitFor(
    async () => summaries(),
    (values) =>
      values.some(
        (summary) =>
          summary.starting_cursor === first.cursor &&
          summary.safe_ending_cursor === second.cursor,
      ),
    "the resumed sequence-cycle summary",
    5_000,
  );

  const cycleSummaries = summaries();
  const firstSummary = cycleSummaries.find(
    (summary) => summary.safe_ending_cursor === first.cursor,
  );
  const secondSummary = cycleSummaries.find(
    (summary) =>
      summary.starting_cursor === first.cursor &&
      summary.safe_ending_cursor === second.cursor,
  );
  assert(firstSummary, "Missing timestamp-bridge cycle summary");
  assert(secondSummary, "Missing resumed sequence-cycle summary");
  for (const [label, summary] of [
    ["bridge", firstSummary],
    ["resumed seq", secondSummary],
  ]) {
    assert(
      summary.connection_errors === 0,
      `${label} cycle reported connection_errors=${summary.connection_errors}`,
    );
    assert(
      summary.cpu_ms === null,
      `${label} cycle did not degrade throwing CPU telemetry to null`,
    );
  }

  console.log(
    `workerd smoke passed: ${first.cursor} -> ${second.cursor}; ` +
      "host fetch preflight succeeded and cpu_ms=null",
  );
} catch (error) {
  console.error(error);
  console.error("\n--- Wrangler output ---\n" + output.slice(-30_000));
  process.exitCode = 1;
} finally {
  await stopWrangler();
  await rm(STATE_DIR, { recursive: true, force: true });
}
