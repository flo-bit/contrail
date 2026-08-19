---
"@atmo-dev/contrail": minor
---

Remove whole-service contract digests with clean version-2 service manifests and provider locks. Anonymous generated clients now call providers without a discovery preflight, while content-addressed Lexicon verification and service-auth discovery remain. `contrail connect` now accepts owned config files or directories to generate a local typed API without changing the deployment lock, generated clients expose local/target factories, and `contrail dev` no longer writes consumer connection artifacts.
