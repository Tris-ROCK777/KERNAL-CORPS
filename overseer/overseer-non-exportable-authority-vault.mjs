/**
 * KERNEL CORP. — experimental non-exportable authority key storage.
 *
 * This is an additive migration primitive. It is NOT wired into production
 * bootstrap until browser persistence and identity migration are verified.
 *
 * IndexedDB stores the CryptoKey object via structured clone; no private JWK
 * is written to application storage. Browser/device compromise and same-origin
 * script execution remain outside this storage layer's protection boundary.
 */
const DB_NAME = "kernel-authority-vault";
const STORE_NAME = "keys";
const KEY_ID = "pinned-authority-v1";
const PIN_FORMAT = /^[a-f0-9]{64}$/i;

const cryptoProvider = () => {
  if (!globalThis.crypto?.subtle) throw new Error("WEBCRYPTO_UNAVAILABLE");
  return globalThis.crypto;
};

const toHex = bytes => Array.from(new Uint8Array(bytes),
  byte => byte.toString(16).padStart(2, "0")).join("");

function openDatabase(indexedDBProvider, databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBProvider.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("AUTHORITY_IDB_OPEN_FAILED"));
    request.onblocked = () => reject(new Error("AUTHORITY_IDB_OPEN_BLOCKED"));
  });
}

async function withStore(db, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    try {
      transaction = db.transaction(STORE_NAME, mode);
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (error) {
      reject(error);
      return;
    }

    let result;
    let requestSucceeded = false;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onsuccess = () => {
      result = request.result;
      requestSucceeded = true;
    };
    request.onerror = () => fail(new Error("AUTHORITY_IDB_OPERATION_FAILED"));
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      if (!requestSucceeded) {
        reject(new Error("AUTHORITY_IDB_OPERATION_DID_NOT_COMPLETE"));
        return;
      }
      resolve(result);
    };
    transaction.onerror = () => fail(new Error("AUTHORITY_IDB_TRANSACTION_FAILED"));
    transaction.onabort = () => fail(new Error("AUTHORITY_IDB_TRANSACTION_ABORTED"));
  });
}

/**
 * Stores a non-exportable private CryptoKey while keeping the public key
 * available for comparison against the application-pinned trust anchor.
 *
 * The first-time enrollment/migration must be an explicit operation. This
 * class never silently generates a replacement when an expected pin is set.
 */
export class NonExportableAuthorityVault {
  constructor({ indexedDB = globalThis.indexedDB, crypto = null,
    expectedPublicKeyHex, databaseName = DB_NAME } = {}) {
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.crypto = crypto || cryptoProvider();
    this.expectedPublicKeyHex = expectedPublicKeyHex?.toLowerCase() || null;
    this.dbPromise = null;
    this.keyPair = null;
    this.publicKeyHex = null;
    this.restored = false;
  }

  async database() {
    if (!this.indexedDB) throw new Error("INDEXEDDB_UNAVAILABLE");
    if (!this.dbPromise) this.dbPromise = openDatabase(this.indexedDB, this.databaseName);
    return this.dbPromise;
  }

  async initOrRestore({ allowFirstBootProvisioning = false } = {}) {
    if (this.keyPair) return this.keyPair;
    const db = await this.database();
    const record = await withStore(db, "readonly", store => store.get(KEY_ID));

    if (record) {
      if (record.schema !== 1 || record.algorithm !== "Ed25519" ||
          !record.privateKey || record.privateKey.extractable !== false ||
          record.privateKey.type !== "private" ||
          !record.publicKey || !PIN_FORMAT.test(record.publicKeyHex || "")) {
        throw new Error("AUTHORITY_IDB_RECORD_INVALID");
      }
      const actual = record.publicKeyHex.toLowerCase();
      if (this.expectedPublicKeyHex && actual !== this.expectedPublicKeyHex) {
        throw new Error("AUTHORITY_PUBLIC_KEY_PIN_MISMATCH");
      }
      const challenge = new TextEncoder().encode("KERNEL_CORP_AUTHORITY_KEYPAIR_CHECK_V1");
      const signature = await this.crypto.subtle.sign("Ed25519", record.privateKey, challenge);
      if (!await this.crypto.subtle.verify("Ed25519", record.publicKey, signature, challenge)) {
        throw new Error("AUTHORITY_KEYPAIR_MISMATCH");
      }
      this.keyPair = { privateKey: record.privateKey, publicKey: record.publicKey };
      this.publicKeyHex = actual;
      this.restored = true;
      return this.keyPair;
    }

    if (this.expectedPublicKeyHex || allowFirstBootProvisioning !== true) {
      throw new Error(this.expectedPublicKeyHex
        ? "PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT"
        : "EXPLICIT_FIRST_BOOT_PROVISIONING_REQUIRED");
    }

    // Generate an extractable pair only long enough to export the public key
    // and re-import the private key as non-exportable. No private JWK is stored.
    const generated = await this.crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"]);
    const publicRaw = await this.crypto.subtle.exportKey("raw", generated.publicKey);
    const privateJwk = await this.crypto.subtle.exportKey("jwk", generated.privateKey);
    const privateKey = await this.crypto.subtle.importKey(
      "jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
    for (const key of Object.keys(privateJwk)) {
      if (key === "d" || key === "x") privateJwk[key] = "";
    }
    const publicKey = await this.crypto.subtle.importKey(
      "raw", publicRaw, { name: "Ed25519" }, false, ["verify"]);
    const publicKeyHex = toHex(publicRaw);
    if (this.expectedPublicKeyHex && publicKeyHex !== this.expectedPublicKeyHex) {
      throw new Error("AUTHORITY_PUBLIC_KEY_PIN_MISMATCH");
    }

    await withStore(db, "readwrite", store => store.put({
      schema: 1, algorithm: "Ed25519", publicKeyHex, privateKey, publicKey
    }, KEY_ID));
    this.keyPair = { privateKey, publicKey };
    this.publicKeyHex = publicKeyHex;
    this.restored = false;
    return this.keyPair;
  }

  /**
   * Explicitly migrate an already-enrolled OPFS/JWK identity into IndexedDB.
   * The caller must supply the legacy record read from the existing vault.
   * Migration is pin-bound, verifies private/public correspondence, and never
   * provisions a replacement identity. The legacy OPFS record is not deleted
   * here; cleanup must happen only after a separately verified migration.
   */
  async migrateExistingIdentity(legacyRecord) {
    if (!this.expectedPublicKeyHex || !PIN_FORMAT.test(this.expectedPublicKeyHex)) {
      throw new Error("MIGRATION_REQUIRES_TRUSTED_PUBLIC_KEY_PIN");
    }
    if (!legacyRecord || legacyRecord.schema !== 1 ||
        legacyRecord.algorithm !== "Ed25519" ||
        !legacyRecord.privateJwk ||
        !PIN_FORMAT.test(legacyRecord.publicKeyHex || "")) {
      throw new Error("LEGACY_AUTHORITY_RECORD_INVALID");
    }
    const legacyPin = legacyRecord.publicKeyHex.toLowerCase();
    if (legacyPin !== this.expectedPublicKeyHex) {
      throw new Error("LEGACY_AUTHORITY_PUBLIC_KEY_PIN_MISMATCH");
    }

    const db = await this.database();
    const existing = await withStore(db, "readonly", store => store.get(KEY_ID));
    if (existing) {
      await this.initOrRestore();
      if (this.publicKeyHex !== legacyPin) {
        throw new Error("AUTHORITY_PUBLIC_KEY_PIN_MISMATCH");
      }
      return { keyPair: this.keyPair, status: "EXISTING_NON_EXPORTABLE_IDENTITY_CONFIRMED",
        publicKeyHex: this.publicKeyHex };
    }

    const privateKey = await this.crypto.subtle.importKey(
      "jwk", legacyRecord.privateJwk, { name: "Ed25519" }, false, ["sign"]);
    const publicKey = await this.crypto.subtle.importKey(
      "raw", Uint8Array.from(legacyPin.match(/.{2}/g), byte => Number.parseInt(byte, 16)),
      { name: "Ed25519" }, false, ["verify"]);
    const challenge = new TextEncoder().encode("KERNEL_CORP_AUTHORITY_KEYPAIR_CHECK_V1");
    const signature = await this.crypto.subtle.sign("Ed25519", privateKey, challenge);
    if (!await this.crypto.subtle.verify("Ed25519", publicKey, signature, challenge)) {
      throw new Error("AUTHORITY_KEYPAIR_MISMATCH");
    }

    await withStore(db, "readwrite", store => store.put({
      schema: 1, algorithm: "Ed25519", publicKeyHex: legacyPin, privateKey, publicKey
    }, KEY_ID));

    // Restore through the normal read path to prove the structured-cloned
    // CryptoKey survived persistence and is still non-exportable.
    this.keyPair = null;
    this.publicKeyHex = null;
    this.restored = false;
    const restoredPair = await this.initOrRestore();
    if (restoredPair.privateKey.extractable !== false ||
        this.publicKeyHex !== legacyPin) {
      throw new Error("NON_EXPORTABLE_AUTHORITY_MIGRATION_READBACK_FAILED");
    }
    return { keyPair: restoredPair, status: "EXISTING_IDENTITY_MIGRATED",
      publicKeyHex: this.publicKeyHex };
  }

  getPublicKeyHex() {
    if (!this.publicKeyHex) throw new Error("AUTHORITY_VAULT_NOT_INITIALIZED");
    return this.publicKeyHex;
  }

  getStatus() {
    return { initialized: Boolean(this.keyPair), restored: this.restored,
      publicKeyHex: this.publicKeyHex,
      privateKeyExtractable: this.keyPair?.privateKey.extractable ?? null };
  }
}
