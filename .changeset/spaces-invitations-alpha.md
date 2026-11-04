---
"@atmo-dev/contrail": minor
---

Add opt-in isolated projection, exact service-auth and record-validation extension seams for PDS-hosted Spaces. Keep the public projection, validator, moderation authentication and routes unchanged by default.

Add the workspace-private Spaces extension targeting the October 29 alpha: single explicit policies, space/memberspace/managedspace endpoints, authenticated published-policy discovery, body-based credential exchange, tagged HTTP signatures, MAC/KEM verification and STAR recovery. Re-register notifications when the authority PDS changes. Add PDS-owned reusable invitation operations with personalspace control storage with app-owned offline host authorization; application UI and real-PDS rollout remain separate release gates.
