// Local-only workerd/D1 + Jetstream v2 runtime smoke test; no live network dependency.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const STATE_DIR = await mkdtemp(
  resolve(tmpdir(), "contrail-workerd-runtime-smoke-"),
);
const MARKER = "[ingest] cycle summary ";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SUBSCRIBE_PATH = "/xrpc/network.bsky.jetstream.subscribeEvents";

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeWsCloseFrame() {
  return Buffer.from([0x88, 0x02, 0x03, 0xe8]); // 1000 Normal Closure
}

/** Minimal local Jetstream v2 server implementing both the HTTP 426 seq-cursor
 *  preflight probe and WebSocket commit delivery without external dependencies. */
async function startMockJetstream() {
  let nextSeq = 100;
  const preflightCursors = [];
  const wsCursors = [];
  const sockets = new Set();

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === SUBSCRIBE_PATH) {
      preflightCursors.push(url.searchParams.get("cursor"));
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Upgrade Required");
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== SUBSCRIBE_PATH || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    wsCursors.push(url.searchParams.get("cursor"));

    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const seq = nextSeq++;
    const now = new Date().toISOString();
    const frame = JSON.stringify({
      $type: "message",
      payload: {
        $type: "network.bsky.jetstream.subscribeEvents#commit",
        seq,
        did: "did:plc:workerdsmoke000000000000",
        time: now,
        rev: `3lmb4567890a${seq}`,
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: `smoke-${seq}`,
        cid: `bafyreibsmoke${seq}`,
        record: {
          $type: "app.bsky.feed.post",
          text: `workerd smoke ${seq}`,
          createdAt: now,
        },
      },
    });
    socket.write(encodeWsTextFrame(frame));
    socket.write(encodeWsCloseFrame());
    socket.end();
  });

  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (port === null) throw new Error("Could not bind local mock Jetstream port");

  return {
    url: `http://127.0.0.1:${port}`,
    preflightCursors,
    wsCursors,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClosed) => server.close(resolveClosed));
    },
  };
}

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

const mockJetstream = await startMockJetstream();
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
    "--var",
    `JETSTREAM_URL:${mockJetstream.url}`,
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
      return await waitFor(state, predicate, label, 15_000);
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
  assert(first.cursor === 100, `Expected first seq cursor 100, got ${first.cursor}`);

  const second = await advanceCursor(
    (value) => value.cursorDomain === "seq" && value.cursor > first.cursor,
    "an existing sequence cursor to pass preflight and advance",
  );
  assert(second.cursor === 101, `Expected second seq cursor 101, got ${second.cursor}`);
  assert(
    mockJetstream.preflightCursors.includes("100"),
    `Expected HTTP 426 seq preflight for cursor 100, saw ${JSON.stringify(mockJetstream.preflightCursors)}`,
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
      "local mock Jetstream HTTP 426 preflight succeeded and cpu_ms=null",
  );
} catch (error) {
  console.error(error);
  console.error("\n--- Wrangler output ---\n" + output.slice(-30_000));
  process.exitCode = 1;
} finally {
  await stopWrangler();
  await mockJetstream.close();
  await rm(STATE_DIR, { recursive: true, force: true });
}
