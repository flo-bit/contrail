import { join, resolve } from "node:path";
import type { CAC } from "cac";
import {
  checkLexicons,
  generateLexicons,
  type LexiconSurface,
} from "../../lexicons/generate.js";
import {
  generateLexiconTypesWithAtcute,
  pullLexiconsWithAtcute,
} from "../atcute.js";
import { resolveAndLoadConfig } from "../shared.js";

interface LexiconOptions {
  config?: string;
  root: string;
  output: string;
  public?: boolean;
  atcuteConfig?: boolean;
}

function surface(options: LexiconOptions): LexiconSurface {
  return options.public ? "public" : "full";
}

async function generate(options: LexiconOptions) {
  const config = await resolveAndLoadConfig(options);
  return generateLexicons({
    config,
    rootDir: resolve(options.root),
    outputDir: resolve(options.root, options.output),
    surface: surface(options),
    writeAtcuteConfig: options.atcuteConfig !== false,
  });
}

export function registerLexicons(cli: CAC): void {
  cli
    .command(
      "lexicons <action>",
      "Generate Contrail Lexicons or delegate pulling/typegen to Atcute",
    )
    .option("--config <path>", "Path to Contrail config file")
    .option("--root <path>", "Project root", { default: process.cwd() })
    .option("--output <path>", "Generated output relative to root", {
      default: join("lexicons", "generated"),
    })
    .option("--public", "Generate only methods exposed by public read mode")
    .option(
      "--no-atcute-config",
      "Do not create or update a generated lex.config.js",
    )
    .action(async (action: string, options: LexiconOptions) => {
      const root = resolve(options.root);
      if (action === "generate") {
        await generate(options);
        return;
      }
      if (action === "check") {
        const config = await resolveAndLoadConfig(options);
        checkLexicons({
          config,
          rootDir: root,
          outputDir: resolve(root, options.output),
          surface: surface(options),
          writeAtcuteConfig: options.atcuteConfig !== false,
        });
        console.log("Contrail Lexicons are current.");
        return;
      }
      if (action === "pull") {
        pullLexiconsWithAtcute(root);
        return;
      }
      if (action === "types") {
        generateLexiconTypesWithAtcute(root);
        return;
      }
      if (action === "all") {
        let previous: string | undefined;
        for (let pass = 0; pass < 5; pass++) {
          const result = await generate(options);
          const current = JSON.stringify(result.pullNsids);
          pullLexiconsWithAtcute(root);
          if (current === previous) break;
          previous = current;
          if (pass === 4) {
            throw new Error("Lexicon reference discovery did not converge");
          }
        }
        await generate(options);
        generateLexiconTypesWithAtcute(root);
        return;
      }
      throw new Error(
        `unknown lexicons action ${JSON.stringify(action)}; expected generate, check, pull, types, or all`,
      );
    });
}
