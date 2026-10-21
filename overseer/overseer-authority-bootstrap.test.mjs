import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {initializeTrustedAuthority} from "./overseer-authority-bootstrap.mjs";

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
await assert.rejects(
  () => initializeTrustedAuthority({vaultOptions:{root}}),
  /AUTHORITY_PIN_NOT_CONFIGURED/
);

const first = await initializeTrustedAuthority({vaultOptions:{root}});
assert.equal(first.status, "TRUSTED_AUTHORITY_INITIALIZED");
assert.equal(first.restored, false);
const pin = first.publicKeyHex;

const restored = await initializeTrustedAuthority({publicKeyHex:pin, vaultOptions:{root}});
assert.equal(restored.status, "TRUSTED_AUTHORITY_INITIALIZED");
assert.equal(restored.restored, true);
assert.equal(restored.publicKeyHex, pin);

await assert.rejects(
  () => initializeTrustedAuthority({publicKeyHex:"cd".repeat(32), vaultOptions:{root}}),
  /AUTHORITY_PUBLIC_KEY_PIN_MISMATCH|RESTORED_AUTHORITY_KEY_DOES_NOT_MATCH_PIN/
);

console.log(JSON.stringify({status:"AUTHORITY_BOOTSTRAP_TESTS_PASSED",checks:[
  "missing-trust-pin-rejected","first-boot-explicit-provisioning-only",
  "matching-pin-restores-identity","mismatched-pin-rejected"
]}));
