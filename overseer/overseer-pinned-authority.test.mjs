import assert from "node:assert/strict";
import {verifyAndInitializeVault} from "./overseer-pinned-authority.mjs";

const trusted = "ab".repeat(32);
let initialized = 0;
const vault = {
  async initOrRestore() { initialized++; return {restored:true}; },
  async getPublicKeyHex() { return trusted; }
};
assert.deepEqual(await verifyAndInitializeVault(vault,trusted),{restored:true});
assert.equal(initialized,1);
await assert.rejects(
  () => verifyAndInitializeVault({...vault,async getPublicKeyHex(){return "cd".repeat(32);}},trusted),
  /RESTORED_AUTHORITY_KEY_DOES_NOT_MATCH_PIN/
);
await assert.rejects(() => verifyAndInitializeVault(vault,"743ef50a8a4a07d90d4c32f7dde33651e46a071611afd4c215684465a46fd45c"),
  /RESTORED_AUTHORITY_KEY_DOES_NOT_MATCH_PIN/
);
console.log(JSON.stringify({status:"PINNED_AUTHORITY_TESTS_PASSED",checks:["matching-pin-accepted","mismatched-key-rejected","receipt-hash-not-accepted-as-public-key-pin"]}));
