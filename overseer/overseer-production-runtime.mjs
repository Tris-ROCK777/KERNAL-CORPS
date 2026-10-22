/**
 * KERNEL CORP. — Production Overseer runtime.
 *
 * Restores the enrolled authority, validates its pin, initializes OPFS recovery,
 * and installs awaited durability receipts at the canonical HOTSWAP_COMMIT WAL
 * boundary. No first-boot key generation or trust-root replacement is performed.
 */
import { OverseerHotSwap } from "./overseer-hotswap.mjs";
import { initializeTrustedAuthority } from "./overseer-authority-bootstrap.mjs";
import { OverseerAuthoritySignatureEngine } from "./overseer-authority-signatures.mjs";
import { OverseerAuthoritativeCommitPipeline } from "./overseer-authoritative-commit-pipeline.mjs";

let runtimePromise = null;

export async function initializeProductionOverseer({
  publicKeyHex,
  vaultOptions = {},
  hotSwapOptions = {},
  bridgeOptions = {},
} = {}) {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    if (!globalThis.isSecureContext) throw new Error("SECURE_CONTEXT_REQUIRED");
    if (!globalThis.navigator?.storage?.getDirectory) throw new Error("OPFS_UNAVAILABLE");
    if (!globalThis.crypto?.subtle) throw new Error("WEBCRYPTO_UNAVAILABLE");

    const authority = await initializeTrustedAuthority({
      ...(publicKeyHex ? { publicKeyHex } : {}),
      vaultOptions,
    });
    const keyPair = await authority.vault.initOrRestore();
    const signatureEngine = new OverseerAuthoritySignatureEngine({
      keyPair,
      expectedPublicKeyHex: authority.publicKeyHex,
    });

    const hotSwap = new OverseerHotSwap({
      ...hotSwapOptions,
      publicKey: keyPair.publicKey,
      signatureAlgorithm: "Ed25519",
    });
    await hotSwap.init();

    const pipeline = new OverseerAuthoritativeCommitPipeline(hotSwap, {
      keyVault: authority.vault,
      authoritySignatureEngine: signatureEngine,
      storage: { target: "opfs", ...bridgeOptions },
    });

    try {
      await pipeline.init();
      const chain = await pipeline.verifyReceiptChain();
      if (!chain.valid) throw new Error("DURABILITY_CHAIN_INVALID: " + chain.reason);

      let closed = false;
      return Object.freeze({
        status: "PRODUCTION_PERSISTENCE_INITIALIZED",
        authorityPublicKeyHex: authority.publicKeyHex,
        authorityRestored: authority.restored,
        hotSwap,
        pipeline,

        async commitMutation(podId, code, options = {}) {
          if (closed) throw new Error("OVERSEER_RUNTIME_CLOSED");
          const result = await pipeline.commitMutation(podId, code, options);
          if (result.durability !== "RECEIPT_PERSISTED") {
            throw new Error("DURABILITY_RECEIPT_NOT_CONFIRMED");
          }
          return result;
        },

        async verifyDurability() {
          if (closed) throw new Error("OVERSEER_RUNTIME_CLOSED");
          const result = await pipeline.verifyReceiptChain();
          if (!result.valid) throw new Error("DURABILITY_CHAIN_INVALID: " + result.reason);
          return result;
        },

        async close() {
          if (closed) return;
          await pipeline.flush();
          pipeline.dispose();
          closed = true;
        },
      });
    } catch (error) {
      pipeline.dispose();
      throw error;
    }
  })();

  try {
    return await runtimePromise;
  } catch (error) {
    runtimePromise = null;
    throw error;
  }
}
