import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath, relative as relativePath } from "node:path";
import type { CAC } from "cac";

interface AppendScheduledOpts {
  root: string;
  worker: string;
  cronPath: string;
  secretEnv: string;
}

const MARKER = "// contrail: scheduled handler";

/**
 * Patch a SvelteKit/adapter-cloudflare worker bundle to expose a `scheduled()`
 * handler. The adapter doesn't surface scheduled exports natively
 * (sveltejs/kit#4841), so we append one that POSTs to an in-app cron endpoint
 * (typically /api/cron) using a shared secret.
 */
export function registerAppendScheduled(cli: CAC): void {
  cli
    .command(
      "append-scheduled",
      "Patch a SvelteKit/adapter-cloudflare _worker.js with a scheduled() handler that hits an HTTP cron endpoint. Run after `vite build` in your build script."
    )
    .option("--root <path>", "Project root for resolving --worker", {
      default: process.cwd(),
    })
    .option("--worker <path>", "Path to the generated worker bundle", {
      default: ".svelte-kit/cloudflare/_worker.js",
    })
    .option(
      "--cron-path <path>",
      "In-app path the scheduled handler hits",
      { default: "/api/cron" }
    )
    .option("--secret-env <name>", "Env var holding the cron secret", {
      default: "CRON_SECRET",
    })
    .action((options: AppendScheduledOpts) => {
      const workerPath = resolvePath(options.root, options.worker);

      let code: string;
      try {
        code = readFileSync(workerPath, "utf-8");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          console.error(
            `contrail append-scheduled: worker bundle not found at ${workerPath}\n` +
              "Run your framework build (e.g. `vite build`) first, or pass --worker <path>."
          );
          process.exit(1);
        }
        throw err;
      }

      if (code.includes(MARKER)) {
        console.log(
          `contrail append-scheduled: ${relativePath(options.root, workerPath)} already patched, skipping.`
        );
        return;
      }

      // A self-import gives us the public default export as a live ESM binding.
      // It is read only after the original module body has initialized it. This
      // supports both anonymous adapter-cloudflare 8 exports and older bundles
      // without parsing/rewriting generated code or creating public asset files.
      let workerBinding = "__contrail_scheduled_worker__";
      while (code.includes(workerBinding)) workerBinding += "_";

      const patched =
        code +
        `
${MARKER} — patched by \`contrail append-scheduled\`
import ${workerBinding} from ${JSON.stringify("./" + basename(workerPath))};
${workerBinding}.scheduled = async function (event, env, ctx) {
\tconst req = new Request(${JSON.stringify("http://localhost" + options.cronPath)}, {
\t\tmethod: "POST",
\t\theaders: {
\t\t\t"Content-Type": "application/json",
\t\t\t"X-Cron-Secret": env[${JSON.stringify(options.secretEnv)}] || ""
\t\t}
\t});
\tctx.waitUntil(this.fetch(req, env, ctx).then((response) => {
\t\tif (!response.ok) {
\t\t\tthrow new Error("Contrail scheduled request failed with HTTP " + response.status);
\t\t}
\t\treturn response;
\t}));
};
`;

      writeFileSync(workerPath, patched);
      console.log(
        `contrail append-scheduled: appended scheduled() → ${options.cronPath} to ${relativePath(options.root, workerPath)}`
      );
    });
}
