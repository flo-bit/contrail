---
"@atmo-dev/contrail": minor
---

Correct service auth to use an exact fragmented DID service audience and deterministic least-privilege OAuth RPC scope. Discovery, provider locks, generated clients, and DID documents now distinguish the base service DID from the JWT audience and pin the protected method set. Existing consumers must reconnect, regenerate, and reauthorize; old plain-DID/wildcard OAuth grants are not compatible.
