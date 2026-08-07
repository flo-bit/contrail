import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectPublicService,
  ensureConsumerClientModule,
  ensureConsumerLexiconConfig,
} from "../src/cli/commands/connect";
import { generateLexiconTypesWithAtcute } from "../src/cli/atcute";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { createApp } from "../src/core/router";
import {
  createIngestEvent,
  ingestRecords,
  initSchema,
  resolveConfig,
  type ContrailConfig,
} from "../src/index";
import { generateLexicons } from "../src/lexicons/generate";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(process.cwd(), `.${label}-`));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("public service consumer integration", () => {
  it("discovers, connects, generates types, compiles, and queries", async () => {
    const serviceRoot = temporaryRoot("public-service");
    const consumerRoot = temporaryRoot("public-consumer");
    const sourceLexicon = {
      lexicon: 1,
      id: "community.example.event",
      defs: {
        main: {
          type: "record",
          key: "tid",
          record: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    writeJson(
      join(serviceRoot, "lexicons/pulled/community/example/event.json"),
      sourceLexicon,
    );
    const config: ContrailConfig = {
      namespace: "com.example",
      profiles: [],
      orderedSource: { source: "jetstream", epoch: "e2e" },
      collections: {
        event: {
          collection: "community.example.event",
          queryable: { name: {} },
        },
      },
    };
    const generated = generateLexicons({
      config,
      rootDir: serviceRoot,
      surface: "public",
      quiet: true,
    });
    const lexicons = [sourceLexicon, ...Object.values(generated.generated)];
    const resolved = resolveConfig(config);
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    await ingestRecords(
      db,
      [
        createIngestEvent({
          uri: "at://did:plc:test/community.example.event/1",
          did: "did:plc:test",
          collection: "community.example.event",
          rkey: "1",
          operation: "create",
          cid: "bafyreievent",
          value: { name: "Typed event" },
          timeUs: 1,
          indexedAt: 1,
        }),
      ],
      resolved,
    );
    const app = createApp(db, resolved, {
      lexicons,
      publicService: { endpoint: "https://api.example.com" },
    });
    const fetcher: typeof fetch = (input, init) =>
      app.fetch(new Request(input, init));

    const connection = await connectPublicService({
      endpoint: "https://api.example.com",
      root: consumerRoot,
      out: "src/contrail/lexicons",
      lock: "contrail.lock.json",
      fetcher,
    });
    const generatedConfig = await ensureConsumerLexiconConfig({
      root: consumerRoot,
      out: "src/contrail/lexicons",
      lock: connection.lock,
    });
    expect(generatedConfig.created).toBe(true);
    generateLexiconTypesWithAtcute(consumerRoot);
    const generatedClient = await ensureConsumerClientModule({
      root: consumerRoot,
      lock: connection.lock,
    });
    expect(generatedClient.created).toBe(true);

    mkdirSync(join(consumerRoot, "src"), { recursive: true });
    writeFileSync(
      join(consumerRoot, "src", "consumer.ts"),
      `import { contrail } from "./contrail/index.js";
const response = await contrail.get("com.example.event.listRecords", {
  params: { name: "Typed event", limit: 1 },
});
if (response.ok) {
  const name: string = response.data.records[0]!.value.name;
  console.log(name);
}
`,
    );
    writeJson(join(consumerRoot, "tsconfig.json"), {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    });
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath ? process.execPath : "pnpm";
    const args = npmExecPath
      ? [
          npmExecPath,
          "exec",
          "tsc",
          "--project",
          join(consumerRoot, "tsconfig.json"),
        ]
      : ["exec", "tsc", "--project", join(consumerRoot, "tsconfig.json")];
    const checked = spawnSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);

    const queried = await app.fetch(
      new Request(
        "https://api.example.com/xrpc/com.example.event.listRecords?name=Typed%20event&limit=1",
      ),
    );
    expect(queried.status).toBe(200);
    expect(await queried.json()).toMatchObject({
      records: [{ value: { name: "Typed event" } }],
    });
  });
});
