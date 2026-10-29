import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { cac } from "cac";
import { registerAppendScheduled } from "../src/cli/commands/append-scheduled.js";

const defaultWorker = ".svelte-kit/cloudflare/_worker.js";
const handler = `{
  existing: "preserved",
  async fetch(request, env, ctx) {
    if (env.FAIL) throw new Error("cron failed");
    return new Response(JSON.stringify({
      url: request.url,
      method: request.method,
      contentType: request.headers.get("Content-Type"),
      secret: request.headers.get("X-Cron-Secret"),
      binding: env.MARKER,
      context: ctx.marker,
      existing: this.existing
    }));
  }
}`;

describe("append-scheduled", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "contrail-append-scheduled-"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function patch(worker = defaultWorker, options: string[] = []) {
    const cli = cac("contrail");
    registerAppendScheduled(cli);
    cli.parse([
      "node",
      "contrail",
      "append-scheduled",
      "--root",
      root,
      "--worker",
      worker,
      ...options,
    ]);
  }

  function fixture(
    source: string,
    worker = defaultWorker,
    options: string[] = [],
  ) {
    const file = join(root, worker);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    patch(worker, options);
    return file;
  }

  // Use native ESM in a separate Node process, not Vitest's module transform:
  // merely checking the generated text would miss the original startup failure.
  function run(file: string, code: string) {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import assert from "node:assert/strict";
      const { default: worker } = await import(${JSON.stringify(pathToFileURL(file).href)});
      ${code}
    `,
        ],
        { encoding: "utf8" },
      ),
    );
  }

  it.each([
    ["anonymous adapter-cloudflare 8 export", `export default ${handler};`],
    [
      "legacy bundled export",
      `var worker_default = ${handler}; export { worker_default as default };`,
    ],
    [
      "arbitrary default identifier",
      `const arbitrary = ${handler}; export default arbitrary;`,
    ],
    [
      "export clause before its declaration",
      `export { app as default }; const app = ${handler};`,
    ],
  ])("loads and forwards cron with an %s", (_name, source) => {
    const file = fixture(source);
    expect(
      run(
        file,
        `
      const pending = [];
      const env = { CRON_SECRET: "test-secret", MARKER: "db" };
      const ctx = { marker: "context", waitUntil(promise) { pending.push(promise); } };
      await worker.scheduled({}, env, ctx);
      assert.equal(pending.length, 1);
      console.log(JSON.stringify(await (await pending[0]).json()));
    `,
      ),
    ).toEqual({
      url: "http://localhost/api/cron",
      method: "POST",
      contentType: "application/json",
      secret: "test-secret",
      binding: "db",
      context: "context",
      existing: "preserved",
    });
  });

  it("preserves normal fetch requests", () => {
    const file = fixture(`export default ${handler};`);
    expect(
      run(
        file,
        `
      const response = await worker.fetch(new Request("https://example.com/event"), { MARKER: "db" }, { marker: "http" });
      console.log(JSON.stringify(await response.json()));
    `,
      ),
    ).toEqual({
      url: "https://example.com/event",
      method: "GET",
      contentType: null,
      secret: null,
      binding: "db",
      context: "http",
      existing: "preserved",
    });
  });

  it("supports a custom worker filename, quoted cron path and non-identifier secret name", () => {
    const file = fixture(
      `export default ${handler};`,
      "output/custom worker.mjs",
      [
        "--cron-path",
        '/internal/cron?label="quoted"',
        "--secret-env",
        "CRON-KEY",
      ],
    );
    const result = run(
      file,
      `
      const pending = [];
      await worker.scheduled({}, { "CRON-KEY": "custom-secret" }, {
        waitUntil(promise) { pending.push(promise); }
      });
      console.log(JSON.stringify(await (await pending[0]).json()));
    `,
    );
    expect(result.url).toBe(
      "http://localhost/internal/cron?label=%22quoted%22",
    );
    expect(result.secret).toBe("custom-secret");
  });

  it("does not collide with existing module bindings", () => {
    const file = fixture(
      `const __contrail_scheduled_worker__ = true; export default ${handler};`,
    );
    expect(
      run(file, "console.log(JSON.stringify(typeof worker.scheduled));"),
    ).toBe("function");
  });

  it("keeps failures in the waitUntil promise", () => {
    const file = fixture(`export default ${handler};`);
    expect(
      run(
        file,
        `
      const pending = [];
      await worker.scheduled({}, { FAIL: true }, { waitUntil(promise) { pending.push(promise); } });
      await assert.rejects(pending[0], /cron failed/);
      console.log("true");
    `,
      ),
    ).toBe(true);
  });

  it.each([401, 403, 500, 503])(
    "rejects HTTP %s in the waitUntil promise without exposing secrets",
    (status) => {
      const file = fixture(`export default {
      async fetch() { return new Response("sensitive-secret", { status: ${status} }); }
    };`);
      expect(
        run(
          file,
          `
      const pending = [];
      await worker.scheduled({}, { CRON_SECRET: "sensitive-secret" }, {
        waitUntil(promise) { pending.push(promise); }
      });
      assert.equal(pending.length, 1);
      await assert.rejects(pending[0], (error) => {
        assert.equal(error.message, "Contrail scheduled request failed with HTTP ${status}");
        assert.ok(!error.message.includes("sensitive-secret"));
        return true;
      });
      console.log("true");
    `,
        ),
      ).toBe(true);
    },
  );

  it("sends an empty secret when not configured", () => {
    const file = fixture(`export default ${handler};`);
    expect(
      run(
        file,
        `
      const pending = [];
      await worker.scheduled({}, {}, { waitUntil(promise) { pending.push(promise); } });
      console.log(JSON.stringify((await (await pending[0]).json()).secret));
    `,
      ),
    ).toBe("");
  });

  describe("installed SvelteKit production CSRF guard", () => {
    let app: string;

    beforeAll(() => {
      app = mkdtempSync(join(tmpdir(), "contrail-cron-sveltekit-"));
      // Build with installed SvelteKit 3, not a copy of its CSRF predicate or
      // Vitest's development-mode module transforms. The example still uses v2.
      const packageRoot = fileURLToPath(new URL("../", import.meta.url));
      const require = createRequire(join(packageRoot, "package.json"));
      symlinkSync(
        join(packageRoot, "node_modules"),
        join(app, "node_modules"),
        "dir",
      );
      writeFileSync(join(app, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(app, "vite.config.js"),
        `
        import { sveltekit } from '@sveltejs/kit/vite';
        export default { plugins: [sveltekit()] };
      `,
      );
      mkdirSync(join(app, "src/routes/api/cron"), { recursive: true });
      writeFileSync(
        join(app, "src/app.html"),
        "<html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>",
      );
      writeFileSync(
        join(app, "src/routes/api/cron/+server.js"),
        `
        export async function POST({ request, platform }) {
          if (request.headers.get('X-Cron-Secret') !== platform.env.CRON_SECRET) {
            return new Response('Unauthorized', { status: 401 });
          }
          return Response.json({
            contentType: request.headers.get('Content-Type'),
            binding: platform.env.MARKER,
            context: platform.context.marker
          });
        }
      `,
      );
      execFileSync(
        process.execPath,
        [
          resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js"),
          "build",
        ],
        { cwd: app, encoding: "utf8", stdio: "pipe", timeout: 60_000 },
      );
    }, 60_000);

    afterAll(() => {
      if (app) rmSync(app, { recursive: true, force: true });
    });

    it("rejects the old headerless POST but lets the patched schedule reach the authenticated endpoint", () => {
      const server = pathToFileURL(
        join(app, ".svelte-kit/output/server/index.js"),
      ).href;
      const manifest = pathToFileURL(
        join(app, ".svelte-kit/output/server/manifest.js"),
      ).href;
      const file = fixture(`
        import { Server } from ${JSON.stringify(server)};
        import { manifest } from ${JSON.stringify(manifest)};
        const server = new Server(manifest);
        await server.init({ env: {} });
        export default {
          fetch(request, env, ctx) {
            return server.respond(request, { platform: { env, context: ctx } });
          }
        };
      `);
      expect(
        run(
          file,
          `
        const env = { CRON_SECRET: "test-secret", MARKER: "db" };
        const pending = [];
        const ctx = { marker: "context", waitUntil(promise) { pending.push(promise); } };
        const oldResponse = await worker.fetch(new Request("http://localhost/api/cron", {
          method: "POST", headers: { "X-Cron-Secret": env.CRON_SECRET }
        }), env, ctx);
        assert.equal(oldResponse.status, 403);
        assert.match(await oldResponse.text(), /Cross-site POST form submissions are forbidden/);
        await worker.scheduled({}, env, ctx);
        assert.equal(pending.length, 1);
        const response = await pending[0];
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          contentType: "application/json", binding: "db", context: "context"
        });
        // Missing credentials now reach endpoint authentication instead of CSRF.
        await worker.scheduled({}, { MARKER: "db" }, ctx);
        await assert.rejects(pending[1], /HTTP 401/);
        console.log("true");
      `,
        ),
      ).toBe(true);
    });
  });

  it("is idempotent and does not create extra public files", () => {
    const file = fixture(`export default ${handler};`);
    const first = readFileSync(file, "utf8");
    patch();
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(readdirSync(dirname(file))).toEqual(["_worker.js"]);
  });
});
