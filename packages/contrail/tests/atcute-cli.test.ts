import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createModuleRedirectRegistration } from "../src/cli/atcute";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Atcute CLI module resolution", () => {
  it("redirects an undeclared bare import in an isolated child process", () => {
    const root = mkdtempSync(join(tmpdir(), "contrail-atcute-loader-"));
    roots.push(root);
    const target = join(root, "target.mjs");
    const entry = join(root, "entry.mjs");
    writeFileSync(target, `export const value = "resolved";\n`);
    writeFileSync(
      entry,
      `import { value } from "@missing/runtime-helper";
process.stdout.write(value);
`,
    );

    const registration = createModuleRedirectRegistration(
      "@missing/runtime-helper",
      pathToFileURL(target).href,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", registration, entry],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("resolved");
  });
});
