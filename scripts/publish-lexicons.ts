/**
 * CLI wrapper for `publishLexicons` — publishes contrail's own generated
 * lexicons (under `lexicons-generated/`) to the logged-in account's PDS.
 *
 * Usage:
 *   LEXICON_ACCOUNT_IDENTIFIER=you.bsky.social \
 *   LEXICON_ACCOUNT_PASSWORD=xxxx-xxxx-xxxx-xxxx \
 *   pnpm publish-lexicons
 *
 *   pnpm publish-lexicons <identifier> <app-password>
 */

import { join } from "node:path";
import { publishLexicons } from "../src/publish";

const ROOT = join(import.meta.dirname, "..");

async function main(): Promise<void> {
  const identifier = process.argv[2] ?? process.env.LEXICON_ACCOUNT_IDENTIFIER;
  const password = process.argv[3] ?? process.env.LEXICON_ACCOUNT_PASSWORD;

  if (!identifier || !password) {
    console.error(
      "Usage: pnpm publish-lexicons <handle-or-did> <app-password>\n" +
        "  (or set LEXICON_ACCOUNT_IDENTIFIER and LEXICON_ACCOUNT_PASSWORD env vars)\n\n" +
        "Generate an app password at https://bsky.app/settings/app-passwords\n" +
        "(or equivalent on your PDS)."
    );
    process.exit(1);
  }

  await publishLexicons({
    generatedDir: join(ROOT, "lexicons-generated"),
    identifier,
    password,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
