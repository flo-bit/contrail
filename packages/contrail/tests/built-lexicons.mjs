import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "cli.js");
const root = mkdtempSync(join(packageRoot, ".built-lexicons-"));

function run(command, args, cwd = packageRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ESBUILD_BINARY_PATH: undefined },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result;
}

try {
  const sourcePath = join(
    root,
    "lexicons",
    "pulled",
    "community",
    "example",
    "event.json",
  );
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(
    sourcePath,
    `${JSON.stringify(
      {
        lexicon: 1,
        id: "community.example.event",
        defs: {
          main: {
            type: "record",
            key: "tid",
            record: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const configPath = join(root, "contrail.config.mjs");
  writeFileSync(
    configPath,
    `export default {
  namespace: "com.example",
  profiles: [],
  collections: {
    event: {
      collection: "community.example.event",
      queryable: { name: {} },
    },
  },
};
`,
  );

  run(process.execPath, [
    cli,
    "lexicons",
    "generate",
    "--root",
    root,
    "--config",
    configPath,
    "--public",
  ]);
  run(process.execPath, [
    cli,
    "lexicons",
    "check",
    "--root",
    root,
    "--config",
    configPath,
    "--public",
  ]);

  const generated = JSON.parse(
    readFileSync(
      join(
        root,
        "lexicons",
        "generated",
        "com",
        "example",
        "event",
        "listRecords.json",
      ),
      "utf8",
    ),
  );
  if (generated.defs.main.parameters.properties.name?.type !== "string") {
    throw new Error("generated CLI fixture is missing its query parameter");
  }

  run(process.execPath, [cli, "lexicons", "types", "--root", root]);
  const generatedTypes = join(
    root,
    "src",
    "lexicon-types",
    "types",
    "com",
    "example",
    "event",
    "listRecords.ts",
  );
  readFileSync(generatedTypes, "utf8");

  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          resolveJsonModule: true,
        },
        include: ["src/lexicon-types/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    run(process.execPath, [
      npmExecPath,
      "exec",
      "tsc",
      "--project",
      join(root, "tsconfig.json"),
    ]);
  } else {
    run("pnpm", ["exec", "tsc", "--project", join(root, "tsconfig.json")]);
  }

  console.log("built Lexicon CLI and Atcute type generation passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
