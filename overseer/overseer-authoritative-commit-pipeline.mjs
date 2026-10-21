/**
 * KERNEL CORP. — Authoritative commit pipeline.
 *
 * Initialize after OverseerHotSwap.init() and before creating/attaching the mesh.
 * The engine's appendRingWAL boundary is the source of truth: local mutatePod()
 * and peer-installed commits both pass through it. This avoids async onCommit
 * observers that cannot propagate durability failures to the committing caller.
 */
import {
  OverseerDurabilityBridge,
  installDurabilityBridge
} from "./overseer-durability-bridge.mjs";

export class OverseerAuthoritativeCommitPipeline {
  constructor(hotSwapEngine, options = {}) {
    if (!hotSwapEngine) throw new Error("HOTSWAP_ENGINE_REQUIRED");
    this.engine = hotSwapEngine;
    this.keyVault = options.keyVault || null;
    this.authoritySignatureEngine = options.authoritySignatureEngine || null;
    this.bridge = options.bridge || new OverseerDurabilityBridge(hotSwapEngine, {
      ...(options.storage || {}),
      ...(this.authoritySignatureEngine ? {authoritySignatureEngine:this.authoritySignatureEngine, requireAuthoritySignature:true} : {})
    });
    this.hook = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    // Restore the persistent authority before any signed WAL is verified.
    if (this.keyVault) {
      const keyPair = await this.keyVault.initOrRestore();
      if (!this.authoritySignatureEngine) {
        throw new Error("AUTHORITY_SIGNATURE_ENGINE_REQUIRED_FOR_KEY_VAULT");
      }
      this.authoritySignatureEngine.keyPair = keyPair;
      this.authoritySignatureEngine.expectedPublicKeyHex = this.keyVault.getPublicKeyHex();
      this.bridge.authoritySignatureEngine = this.authoritySignatureEngine;
      this.bridge.requireAuthoritySignature = true;
    }
    await this.bridge.init();
    const chain = await this.bridge.verifyReceiptChain();
    if (!chain.valid) throw new Error("DURABILITY_CHAIN_INVALID: " + chain.reason);
    this.hook = installDurabilityBridge(this.engine, this.bridge);
    this.initialized = true;
    return this;
  }

  async commitMutation(podId, codeString, {signature, source = "LOCAL"} = {}) {
    if (!this.initialized) throw new Error("AUTHORITATIVE_PIPELINE_NOT_INITIALIZED");
    // Engine verifies signature, runs its gate, writes/read-backs shard, and writes
    // HOTSWAP_COMMIT. The installed appendRingWAL boundary then persists the receipt
    // before mutatePod can publish success.
    const result = await this.engine.mutatePod(podId, codeString, {
      signature,
      origin: source === "PEER_MESH" ? "peer" : "local"
    });
    await this.flush();
    return {...result, source, durability:"RECEIPT_PERSISTED"};
  }

  async verifyReceiptChain() {
    if (!this.initialized) throw new Error("AUTHORITATIVE_PIPELINE_NOT_INITIALIZED");
    await this.flush();
    return this.bridge.verifyReceiptChain();
  }

  async flush() {
    if (this.hook) await this.hook.flush();
    await this.bridge.flush();
  }

  dispose() {
    this.hook?.uninstall();
    this.hook = null;
    this.initialized = false;
  }
}
