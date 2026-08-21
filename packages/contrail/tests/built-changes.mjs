import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "contrail-changes-"));
try {
  writeFileSync(
    join(root, "contrail.config.js"),
    `export const config = {
      namespace: "com.example",
      profiles: [],
      collections: { event: { collection: "com.example.event" } },
      changes: { consumers: {
        webhook: { collections: ["com.example.event"], initial: "future" }
      } }
    };\n`,
  );
  const cli = resolve("dist/cli.js");
  const database = join(root, "contrail.sqlite");
  const status = spawnSync(
    process.execPath,
    [cli, "changes", "status", "--root", root, "--sqlite", database, "--json"],
    { cwd: resolve("."), encoding: "utf8" },
  );
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.consumers[0].id, "webhook");

  const retry = spawnSync(
    process.execPath,
    [cli, "changes", "retry", "webhook", "--root", root, "--sqlite", database],
    { cwd: resolve("."), encoding: "utf8" },
  );
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /retry is now due/);
  console.log("built change consumer CLI passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
