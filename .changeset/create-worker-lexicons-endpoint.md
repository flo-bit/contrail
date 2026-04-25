---
"@atmo-dev/contrail": minor
"@atmo-dev/contrail-lexicons": minor
---

two new DX pieces:

**`@atmo-dev/contrail/worker`** exports `createWorker(config, options?)` — a prebuilt Cloudflare Workers entry that collapses the ~12-line `{ fetch, scheduled }` boilerplate to one line:

```ts
import { createWorker } from "@atmo-dev/contrail/worker";
import { config } from "./contrail.config";
import { lexicons } from "../lexicons/generated";

export default createWorker(config, { lexicons });
```

options: `binding` (D1 binding name, default `"DB"`), `lexicons` (see below), `onInit` (one-shot app-specific setup).

**`/xrpc/<ns>.lexicons` endpoint + `contrail-lex pull-service`** lets consumer apps typegen against a deployed contrail over HTTP, no PDS or DNS required:

- `contrail-lex generate` now emits a barrel `lexicons/generated/index.ts` that imports every lexicon the deployment speaks: generated + pulled + custom. The pulled lexicons are needed so consumer typegen can resolve `$ref`s out of the generated schemas.
- Pass `{ lexicons }` to `createWorker` (or `createHandler(contrail, { lexicons })`) and the service exposes them at `GET /xrpc/<namespace>.lexicons`.
- From a consumer app:
  ```bash
  contrail-lex pull-service https://my-contrail.dev/xrpc/com.example.lexicons
  # or
  contrail-lex pull-service https://my-contrail.dev --namespace com.example
  ```
  Fetches the manifest, writes each lexicon under `lexicons/pulled/`. Then `npx lex-cli generate` emits TS types.

Path 1 of 4 of a set of DX improvements — path 2 (consumer typegen) works end-to-end but assumes the operator has regenerated. Paths 3 (one-command deploy) and 4 (fully vendored worker) are deferred.
