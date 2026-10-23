# KERNEL CORP. / AYE•YAE

KERNEL CORP is building a mobile-first, zero-trust, peer-compute and storage system around the Ring-WAL durability pipeline, Ed25519 authority, OPFS persistence, and WebRTC data transfer.

## Canonical live command center

The root site redirects to the X-KOM’Z Overseer at `overseer/index.html`. Keep the four primary work areas inside that UI:

1. **Storage** — OPFS Ring-WAL inspector and durability receipts.
2. **Network** — real WebRTC peer status, authenticated shard transport, and a clearly labelled 96 KiB / 3 × 32 KiB local loopback simulator.
3. **Security** — pinned authority and durability verification; fail closed when trust requirements are not met.
4. **Workers · 10K target** — actual local browser-worker execution and progress toward a future distributed worker grid.

The UI includes the AYE•YAE core and interactive modals for the seven canonical apps: X-KOM’Z, Planet-K, KashKorner, X-Koin’s, Kernelodie’s, KernelVision, and X-Shield

## Canonical code and recovery records

- Production runtime: `overseer/overseer-production-runtime.mjs`
- Durable commit pipeline: `overseer/overseer-authoritative-commit-pipeline.mjs`
- OPFS/Node durability bridge: `overseer/overseer-durability-bridge.mjs`
- WebRTC mesh: `overseer/overseer-mesh-sync.mjs`
- Real peer harness: `overseer/live-peer-verify.html`
- Recovery checkpoint: `RECOVERY/PROJECT_STATE.md`
- Storage evidence: `storage/VERIFICATION_STATUS.md`

Keep work directly on `main`; do not create branches or duplicate command centers.
