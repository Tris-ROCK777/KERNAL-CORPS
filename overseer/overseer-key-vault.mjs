/**
 * KERNEL CORP. — OPFS-persisted Ed25519 authority identity.
 *
 * OPFS persistence survives ordinary reloads/restarts, but is not hardware-backed
 * and may be removed by site-data clearing. The vault file is same-origin data,
 * not protection against compromised same-origin JavaScript or device access.
 */
const VAULT_FILE = "authority.vault.json";
const HEX = /^[a-f0-9]{64}$/i;

function cryptoProvider() {
  if (!globalThis.crypto?.subtle) throw new Error("WEBCRYPTO_UNAVAILABLE");
  return globalThis.crypto;
}
const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
function fromHex(hex) {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Error("INVALID_AUTHORITY_PUBLIC_KEY_HEX");
  return new Uint8Array(hex.match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
}

export class OverseerKeyVault {
  constructor(options = {}) {
    this.root = options.root || null;
    this.crypto = options.crypto || null;
    this.expectedPublicKeyHex = options.expectedPublicKeyHex || null;
    this.keyPair = null;
    this.publicKeyHex = null;
    this.restored = false;
  }

  provider() { return this.crypto || cryptoProvider(); }

  async getRoot() {
    if (this.root) return this.root;
    if (!globalThis.navigator?.storage?.getDirectory) {
      throw new Error("OPFS_UNAVAILABLE: requires HTTPS or localhost in a supporting browser");
    }
    this.root = await navigator.storage.getDirectory();
    return this.root;
  }

  async initOrRestore() {
    if (this.keyPair) return this.keyPair;
    const root = await this.getRoot();
    const dir = await root.getDirectoryHandle("kernel_vault", {create:true});
    const subtle = this.provider().subtle;
    let stored = null;
    try {
      const handle = await dir.getFileHandle(VAULT_FILE);
      stored = JSON.parse(await (await handle.getFile()).text());
    } catch (error) {
      if (error?.name !== "NotFoundError" && error?.code !== "ENOENT") {
        throw new Error("AUTHORITY_VAULT_READ_FAILED: " + (error?.message || String(error)));
      }
    }

    if (stored) {
      if (stored.schema !== 1 || !stored.privateJwk || !HEX.test(stored.publicKeyHex || "")) {
        throw new Error("AUTHORITY_VAULT_FORMAT_INVALID");
      }
      if (this.expectedPublicKeyHex &&
          stored.publicKeyHex.toLowerCase() !== this.expectedPublicKeyHex.toLowerCase()) {
        throw new Error("AUTHORITY_PUBLIC_KEY_PIN_MISMATCH");
      }
      const privateKey = await subtle.importKey("jwk", stored.privateJwk,
        {name:"Ed25519"}, true, ["sign"]);
      const publicKey = await subtle.importKey("raw", fromHex(stored.publicKeyHex),
        {name:"Ed25519"}, true, ["verify"]);

      // Prove the restored private key matches the persisted public key.
      const challenge = new TextEncoder().encode("KERNEL_CORP_AUTHORITY_KEYPAIR_CHECK_V1");
      const signature = await subtle.sign("Ed25519", privateKey, challenge);
      if (!await subtle.verify("Ed25519", publicKey, signature, challenge)) {
        throw new Error("AUTHORITY_KEYPAIR_MISMATCH");
      }
      this.keyPair = {privateKey, publicKey};
      this.publicKeyHex = stored.publicKeyHex.toLowerCase();
      this.restored = true;
      return this.keyPair;
    }

    if (this.expectedPublicKeyHex) {
      throw new Error("PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT");
    }
    const pair = await subtle.generateKey({name:"Ed25519"}, true, ["sign","verify"]);
    const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
    const publicKeyHex = toHex(await subtle.exportKey("raw", pair.publicKey));
    const vaultRecord = JSON.stringify({schema:1, algorithm:"Ed25519", publicKeyHex, privateJwk});
    const file = await dir.getFileHandle(VAULT_FILE, {create:true});
    const writable = await file.createWritable();
    try {
      await writable.write(vaultRecord);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch {}
      throw new Error("AUTHORITY_VAULT_WRITE_FAILED: " + (error?.message || String(error)));
    }
    this.keyPair = pair;
    this.publicKeyHex = publicKeyHex;
    this.restored = false;
    return this.keyPair;
  }

  getPublicKeyHex() {
    if (!this.publicKeyHex) throw new Error("AUTHORITY_VAULT_NOT_INITIALIZED");
    return this.publicKeyHex;
  }

  getStatus() {
    return {initialized:Boolean(this.keyPair), restored:this.restored, publicKeyHex:this.publicKeyHex};
  }
}
