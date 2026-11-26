import { join, resolve } from "node:path";
import type { CAC } from "cac";
import {
  checkLexicons,
  generateLexicons,
  type LexiconSurface,
} from "../../lexicons/generate.js";
import { resolveAndLoadConfig } from "../shared.js";

interface LexiconOptions {
  config?: string;
  root: string;
  output: string;
  public?: boolean;
  /** Accepted as a no-op for backward compatibility with existing scripts. */
  atcuteConfig?: boolean;
}

function surface(options: LexiconOptions): LexiconSurface {
  return options.public ? "public" : "full";
}

export function registerLexicons(cli: CAC): void {
  cli
    .command(
      "lexicons <action>",
      "Generate or check Contrail XRPC Lexicons (actions: generate, check)",
    )
    .option("--config <path>", "Path to Contrail config file")
    .option("--root <path>", "Project root", { default: process.cwd() })
    .option("--output <path>", "Generated output relative to root", {
      default: join("lexicons", "generated"),
    })
    .option("--public", "Generate only methods exposed by public read mode")
    .option(
      "--no-atcute-config",
      "No-op (lex.config.js is user-managed with @atcute/lex-cli)",
    )
    .action(async (action: string, options: LexiconOptions) => {
      const root = resolve(options.root);
      const outputDir = resolve(root, options.output);
      if (action === "generate") {
        const config = await resolveAndLoadConfig(options);
        generateLexicons({
          config,
          rootDir: root,
          outputDir,
          surface: surface(options),
        });
        return;
      }
      if (action === "check") {
        const config = await resolveAndLoadConfig(options);
        checkLexicons({
          config,
          rootDir: root,
          outputDir,
          surface: surface(options),
        });
        console.log("Contrail Lexicons are current.");
        return;
      }
      if (action === "pull" || action === "types" || action === "all") {
        throw new Error(
          `\`contrail lexicons ${action}\` was removed; run \`contrail lexicons generate\` and invoke \`@atcute/lex-cli\` (\`lex-cli pull\` / \`lex-cli generate\`) directly`,
        );
      }
      throw new Error(
        `unknown lexicons action ${JSON.stringify(action)}; expected generate or check`,
      );
    });
}
