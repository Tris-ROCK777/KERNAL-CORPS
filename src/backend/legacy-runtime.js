/**
 * Backend preservation boundary.
 * The authoritative WebRTC, signing, OPFS and Ring-WAL modules remain in
 * overseer/ unchanged. Do not reimplement or mock their security guarantees
 * in the React presentation layer. Import their existing public APIs here
 * as each integration is migrated and covered by the existing verification
 * suites.
 */
export const BACKEND_MODULES = Object.freeze({
  hotSwap: '../../overseer/overseer-hotswap.mjs',
  meshSync: '../../overseer/overseer-mesh-sync.mjs',
});
