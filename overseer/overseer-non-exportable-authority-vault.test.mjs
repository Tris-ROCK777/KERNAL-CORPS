import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { NonExportableAuthorityVault } from "./overseer-non-exportable-authority-vault.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

// Minimal IndexedDB-compatible test double for deterministic Node tests.
// Real browser IndexedDB persistence is still covered by a separate browser test.
function makeIndexedDB() {
  const databases = new Map();
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = { stores: new Map(), objectStoreNames: {
            contains(store) { return db.stores.has(store); }
          }};
          databases.set(name, db);
        }
        request.result = {
          objectStoreNames: db.objectStoreNames,
          createObjectStore(store) { db.stores.set(store, new Map()); },
          transaction(storeName) {
            const data = db.stores.get(storeName);
            const transaction = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                return {
                  get(key) {
                    const req = {};
                    queueMicrotask(() => {
                      req.result = data.get(key);
                      req.onsuccess?.();
                      queueMicrotask(() => transaction.oncomplete?.());
                    });
                    return req;
                  },
                  put(value, key) {
                    const req = {};
                    queueMicrotask(() => {
                      data.set(key, value);
                      req.result = key;
                      req.onsuccess?.();
                      queueMicrotask(() => transaction.oncomplete?.());
                    });
                    return req;
                  }
                };
              }
            };
            return transaction;
          }
        };
        if (request.onupgradeneeded && !db.stores.has("keys")) request.onupgradeneeded();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

const indexedDB = makeIndexedDB();
const first = new NonExportableAuthorityVault({ indexedDB, crypto: webcrypto });
await first.initOrRestore({ allowFirstBootProvisioning: true });
const pin = first.getPublicKeyHex();
assert.match(pin, /^[a-f0-9]{64}$/);
assert.equal(first.getStatus().privateKeyExtractable, false);

const payload = new TextEncoder().encode("kernel-authority-persistence-check");
const signature = await webcrypto.subtle.sign("Ed25519", first.keyPair.privateKey, payload);
assert.equal(await webcrypto.subtle.verify("Ed25519", first.keyPair.publicKey, signature, payload), true);

const restored = new NonExportableAuthorityVault({
  indexedDB, crypto: webcrypto, expectedPublicKeyHex: pin
});
await restored.initOrRestore();
assert.equal(restored.getPublicKeyHex(), pin);
assert.equal(restored.getStatus().restored, true);
assert.equal(restored.getStatus().privateKeyExtractable, false);

const wrongPin = new NonExportableAuthorityVault({
  indexedDB, crypto: webcrypto, expectedPublicKeyHex: "ab".repeat(32)
});
await assert.rejects(() => wrongPin.initOrRestore(), /AUTHORITY_PUBLIC_KEY_PIN_MISMATCH/);

const absent = new NonExportableAuthorityVault({
  indexedDB: makeIndexedDB(), crypto: webcrypto, expectedPublicKeyHex: pin
});
await assert.rejects(() => absent.initOrRestore(), /PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT/);

const implicitProvision = new NonExportableAuthorityVault({
  indexedDB: makeIndexedDB(), crypto: webcrypto
});
await assert.rejects(() => implicitProvision.initOrRestore(),
  /EXPLICIT_FIRST_BOOT_PROVISIONING_REQUIRED/);

console.log(JSON.stringify({
  status: "NON_EXPORTABLE_AUTHORITY_VAULT_TESTS_PASSED",
  checks: [
    "first-boot-requires-explicit-provisioning",
    "private-key-is-non-exportable",
    "signing-and-verification-work",
    "stored-crypto-key-restores",
    "pinned-public-key-mismatch-rejected",
    "missing-pinned-key-fails-closed"
  ]
}));
