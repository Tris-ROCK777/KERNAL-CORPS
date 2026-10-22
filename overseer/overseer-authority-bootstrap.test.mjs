import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {indexedDB} from "fake-indexeddb";
import {initializeTrustedAuthority, provisionAuthorityIdentity} from "./overseer-authority-bootstrap.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

function makeRoot() {
  const dirs = new Map();
  return {
    async getDirectoryHandle(name, {create} = {}) {
      if (!dirs.has(name)) {
        if (!create) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
        dirs.set(name, new Map());
      }
      const files = dirs.get(name);
      return {
        async getFileHandle(name, {create:make = false} = {}) {
          if (!files.has(name)) {
            if (!make) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
            files.set(name, "");
          }
          return {
            async getFile() { return {async text() { return files.get(name); }}; },
            async createWritable() {
              let value = "";
              return {
                async write(next) { value = String(next); },
                async close() { files.set(name, value); },
                async abort() {}
              };
            }
          };
        }
      };
    }
  };
}

const root = makeRoot();
const vaultOptions = {root, indexedDB};
await assert.rejects(
  () => initializeTrustedAuthority({vaultOptions}),
  /PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT/
);
await assert.rejects(
  () => provisionAuthorityIdentity({vaultOptions:{root}}),
  /EXPLICIT_FIRST_BOOT_PROVISIONING_REQUIRED/
);

const provisioned = await provisionAuthorityIdentity({
  vaultOptions:{root},
  allowFirstBootProvisioning:true
});
assert.equal(provisioned.status, "NEW_IDENTITY_CREATED_REQUIRES_TRUSTED_PIN");
const pin = provisioned.publicKeyHex;

const restored = await initializeTrustedAuthority({publicKeyHex:pin, vaultOptions:{root}});
assert.equal(restored.status, "TRUSTED_NON_EXPORTABLE_AUTHORITY_INITIALIZED");
assert.equal(restored.restored, true);
assert.equal(restored.publicKeyHex, pin);

await assert.rejects(
  () => initializeTrustedAuthority({publicKeyHex:"cd".repeat(32), vaultOptions:{root}}),
  /AUTHORITY_PUBLIC_KEY_PIN_MISMATCH|RESTORED_AUTHORITY_KEY_DOES_NOT_MATCH_PIN/
);

console.log(JSON.stringify({status:"AUTHORITY_BOOTSTRAP_TESTS_PASSED",checks:[
  "missing-pinned-vault-rejected","implicit-first-boot-provisioning-rejected",
  "explicit-first-boot-identity-created","matching-pin-restores-identity","mismatched-pin-rejected"
]}));
