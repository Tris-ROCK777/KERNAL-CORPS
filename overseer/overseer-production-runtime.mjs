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
import { acceptAuthenticatedShard } from "./overseer-authenticated-shard.mjs";
import { isSupportedPodId } from "./overseer-pod-identifiers.mjs";

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
          if (!isSupportedPodId(podId)) throw new Error("UNSUPPORTED_CANONICAL_POD_ID");
          const bytes = new TextEncoder().encode(code);
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            byte => byte.toString(16).padStart(2, "0")).join("");
          const manifest = new TextEncoder().encode(
            "KERNEL_SHARD_V1\n" + digest + "\n" + bytes.byteLength + "\n" + podId);
          const shardSignature = Array.from(new Uint8Array(
            await crypto.subtle.sign("Ed25519", authority.vault.keyPair.privateKey, manifest)),
            byte => byte.toString(16).padStart(2, "0")).join("");
          const authenticatedShard = await acceptAuthenticatedShard({
            bytes, signatureHex: shardSignature,
            publicKey: authority.vault.keyPair.publicKey,
            pinnedPublicKeyHex: authority.publicKeyHex,
            signerPublicKeyHex: authority.publicKeyHex,
            podId
          });
          const codeSignature = options.signature || Array.from(new Uint8Array(
            await crypto.subtle.sign("Ed25519", authority.vault.keyPair.privateKey,
              new TextEncoder().encode(code))),
            byte => byte.toString(16).padStart(2, "0")).join("");
          const result = await pipeline.commitMutation(podId, code, {
            ...options,
            signature: codeSignature
          });
          if (result.durability !== "RECEIPT_PERSISTED") {
            throw new Error("DURABILITY_RECEIPT_NOT_CONFIRMED");
          }
          return {...result, authenticatedShard};
        },

        async signShardManifest({bytes, podId, hash} = {}) {
          if (closed) throw new Error("OVERSEER_RUNTIME_CLOSED");
          if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 1024 * 1024) throw new Error("SHARD_SIZE_OUT_OF_RANGE");
          if (!isSupportedPodId(podId)) throw new Error("UNSUPPORTED_CANONICAL_POD_ID");
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2,"0")).join("");
          if (digest !== String(hash || "").toLowerCase()) throw new Error("SHARD_HASH_MISMATCH");
          const manifest = new TextEncoder().encode("KERNEL_SHARD_V1\n" + digest + "\n" + bytes.byteLength + "\n" + podId);
          return Array.from(new Uint8Array(await crypto.subtle.sign("Ed25519", authority.vault.keyPair.privateKey, manifest)), b => b.toString(16).padStart(2,"0")).join("");
        },

        async acceptRemoteShard({bytes, podId, hash, signatureHex, codeSignature, algorithm} = {}) {
          if (closed) throw new Error("OVERSEER_RUNTIME_CLOSED");
          if (algorithm !== "Ed25519") throw new Error("SIGNATURE_ALGORITHM_POLICY_MISMATCH");
          if (!(bytes instanceof Uint8Array)) throw new Error("SHARD_BYTES_MUST_BE_UINT8ARRAY");
          if (!isSupportedPodId(podId)) throw new Error("UNSUPPORTED_CANONICAL_POD_ID");
          const authenticatedShard = await acceptAuthenticatedShard({bytes, signatureHex,
            publicKey:authority.vault.keyPair.publicKey, pinnedPublicKeyHex:authority.publicKeyHex,
            signerPublicKeyHex:authority.publicKeyHex, podId});
          if (authenticatedShard.sha256 !== String(hash || "").toLowerCase()) throw new Error("AUTHENTICATED_SHARD_HASH_MISMATCH");
          const code = new TextDecoder("utf-8", {fatal:true}).decode(bytes);
          const result = await pipeline.commitMutation(podId, code, {signature:codeSignature, origin:"peer"});
          if (result.durability !== "RECEIPT_PERSISTED") throw new Error("DURABILITY_RECEIPT_NOT_CONFIRMED");
          return {...authenticatedShard, durability:result.durability, commitHash:result.hash};
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
