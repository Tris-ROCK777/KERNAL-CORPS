# KERNEL CORP — Recovered Project State

Repository: https://github.com/Tris-ROCK777/KERNAL-CORPS  
Recovery date: 2026-10-22

## Command center restored
The historical Ring-WAL dashboard was restored to `overseer/index.html` in commit [88b83a6](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/88b83a662f57518e790e48adc236eb7ed7462410). It contains the interactive local-first console, task dispatch controls, OPFS/SHA-256/Ed25519 readouts, receipt handling, and live-peer test link. The GitHub Pages deployment workflow for that exact commit completed successfully: [deployment run #39735051710](https://github.com/Tris-ROCK777/KERNAL-CORPS/actions/runs/39735051710).

## Recovered milestones (existing repository history)
- **Ring-WAL and durable hot-swap:** sandbox validation → OPFS write → SHA-256 read-back → WAL append → in-memory swap; preserve last-known-good state on failures.
- **Crash recovery:** dangling pre-commit recovery inspector, simulated restart tests, pending/terminal durability states, and WAL receipt-recovery parsing.
- **Authority identity:** persisted Ed25519 authority vault, pinned trust root, fail-closed bootstrap, key restoration and migration checks. The IndexedDB non-exportable-key vault remains a prototype and was explicitly not made the active production vault.
- **Peer replication:** bounded 32 KiB chunks, backpressure and transfer expiry limits, signed shard manifests, receiver verification, OPFS read-back, and authenticated receipts.
- **Real-device WebRTC:** MQTT signaling, READY handshake fixes, target-peer filtering, cache-busted imports, and a live test harness.
- **Storage verification:** repository records four successful device passes. A separate two-device run transferred 32,768 bytes with matching expected/actual SHA-256: `743ef50a8a4a07d90d4c32f7dde33651e46a071611afd4c215684465a46fd45c`.
- **Tests and CI:** browser-oriented mesh tests, real-peer signaling regression tests, authority/security workflows, and Pages deployment workflow.

## Key historical commits
- [Automatic Ring-WAL durability receipts](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/361445e838dae86bdf1c3257951392ff584371d1)
- [Automatic receipts from mesh replication](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/92faa03644263ba5ed24118015b36f64209fad8c)
- [Dangling pre-commit recovery inspector](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/9cfd431bbff43f5709a6dcd4dbbfe312aece6015)
- [Simulated-restart recovery test](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/2310f92e655f5439ec071110db02e16158f295b0)
- [Persisted Ed25519 authority vault](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/610fcbe2dbc037d9bd6b4f9ff967b00ae6b5a93f)
- [Pinned authority bootstrap](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/7bb3087752f506badcfe37ffe197200bc94189cc)
- [Authenticated receiver receipts in console](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/2a6c251c300e8f48aab7448767666c76f55f34e7)
- [Four successful device storage passes recorded](https://github.com/Tris-ROCK777/KERNAL-CORPS/commit/40f1cd52221276f7619ef99256e1b2f04c14da13)
- [READY handshake fix](https://github.com/Tris-ROCK777/KERNAL-CORPS/pull/3)
- [MQTT outbound READY fix](https://github.com/Tris-ROCK777/KERNAL-CORPS/pull/5)

## Verification boundaries
- Confirmed: the dashboard restoration commit is on `main`, and its Pages deployment workflow completed successfully.
- Demonstrated on device: four storage passes and one matching 32 KiB test transfer.
- Not established by those checks: production-scale 10,000-worker operation, always-on multi-device replication, or completion of the experimental vault migration.
- The 24 ring slots and 64 worker display in the console are visual/local control values, not evidence of 24 connected peers or 64 active remote workers.

## Resume point
Continue from the restored Ring-WAL dashboard. Do not ask the user to repeat existing tests or re-supply history already in Git. Next verification target is the actual deployed Pages entry and its module loading, followed by an end-to-end live authenticated shard transfer from the dashboard.


## Unified entrypoint and historical branch audit (2026-10-22)

Canonical command plane: `/overseer/index.html` (title: **KERNEL UMBRELLA CORP // X-KOM’Z OVERSEER**). The root `/index.html` already redirects here. The historical names below are compatibility entrypoints; they must not fork the UI or create separate dashboards.

Compatibility pages added at repository root:
- `/command.html` and `/command-center.html`
- `/dashboard.html`
- `/overseer.html`
- `/x-komz.html` and `/x-koms.html`
- `/kernel.html`

All compatibility pages redirect to the same canonical Overseer command plane. The canonical dashboard hosts the live mesh console and provides one embedded workbench for the existing network, Ring-WAL/storage, peer verification, authenticated shard, and authority/vault tools. The seven canonical product cards are X-KOM’Z (hub) plus Planet-K, KashKorner, X-Koin’s, Kernelodie’s, KernelVision, and X-Shield. A card marked “PRODUCT BRIEF” describes a planned product surface; it is not evidence that a separate production app has been built.

### Historical branches checked against `main`

The repository's branch search returned these 13 non-main branches:
- `feat/integrated-overseer-network-dashboard`
- `feat/jarvis-overseer-command-center`
- `feat/jarvis-theme-live-mesh-console`
- `feat/overseer-command-center-completion`
- `feat/overseer-module-launcher`
- `feat/restore-overseer-tool-directory`
- `feat/unified-overseer-command-workbench`
- `fix/allow-mqtt-ready-handshake`
- `fix/cache-bust-live-peer-modules`
- `fix/mqtt-ready-outbound-allowlist`
- `fix/overseer-mobile-command-layout`
- `fix/overseer-mobile-command-layout-v2`
- `redesign/overseer-angular-mesh-ui`

The command-center, module-launcher, mobile-layout, JARVIS-theme, integrated-dashboard, and angular-redesign branches are historical snapshots of overlapping UI iterations. They diverge from current `main`; wholesale replacement would discard later integrations and is not a safe merge strategy. Their core themes are represented by the current canonical command plane and `overseer/mesh-console.html`, which contains the JARVIS theme and actual console controls.

The MQTT/WebRTC branches are also old snapshots. Current `main` was checked directly: `overseer/overseer-real-peer.mjs` contains READY handshake handling; `overseer/overseer-signaling-bootstrap.mjs` allows READY through the signaling transports; and `overseer/live-peer-verify.html` uses cache-busted module imports. Do not reapply stale patches unless a current regression is demonstrated.

### Integration rule

Keep all future UI and runtime fixes directly on `main`, with no new branches or routine pull requests. Extend the canonical workbench, preserve existing modules and tests, and distinguish verified runtime measurements from architecture targets or product briefs.
