import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {OverseerKeyVault} from "./overseer-key-vault.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

function makeOpfs() {
  const files = new Map();
  const dirs = new Map();
  const root = {
    async getDirectoryHandle(name, {create} = {}) {
      if (!dirs.has(name)) {
        if (!create) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
        dirs.set(name, new Map());
      }
      const dir = dirs.get(name);
      return {
        async getFileHandle(filename, {create:make = false} = {}) {
          if (!dir.has(filename)) {
            if (!make) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
            dir.set(filename, "");
          }
          return {
            async getFile() { return {async text() { return dir.get(filename); }}; },
            async createWritable() {
              let value = "";
              return {
                async write(next) { value = typeof next === "string" ? next : String(next); },
                async close() { dir.set(filename, value); },
                async abort() {}
              };
            }
          };
        }
      };
    }
  };
  return root;
}

const root = makeOpfs();
const first = new OverseerKeyVault({root});
await first.initOrRestore();
const originalPublicKey = first.getPublicKeyHex();
assert.equal(originalPublicKey.length, 64);
assert.equal(first.getStatus().restored, false);

const second = new OverseerKeyVault({root, expectedPublicKeyHex:originalPublicKey});
await second.initOrRestore();
assert.equal(second.getPublicKeyHex(), originalPublicKey);
assert.equal(second.getStatus().restored, true);

const challenge = new TextEncoder().encode("restart-check");
const signature = await webcrypto.subtle.sign("Ed25519", second.keyPair.privateKey, challenge);
assert.equal(await webcrypto.subtle.verify("Ed25519", second.keyPair.publicKey, signature, challenge), true);

const wrongPin = new OverseerKeyVault({root, expectedPublicKeyHex:"ab".repeat(32)});
await assert.rejects(() => wrongPin.initOrRestore(), /AUTHORITY_PUBLIC_KEY_PIN_MISMATCH/);

console.log(JSON.stringify({status:"OPFS_AUTHORITY_VAULT_TESTS_PASSED",
  checks:["first-boot-key-created","key-restored-from-persisted-vault","restored-private-key-signs","pinned-key-mismatch-rejected"]}));
