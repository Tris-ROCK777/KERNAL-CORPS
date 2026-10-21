import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {OverseerAuthoritySignatureEngine} from "./overseer-authority-signatures.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const authority = new OverseerAuthoritySignatureEngine();
await authority.initAuthorityKey();
const receipt = {
  op:"HOTSWAP_DURABILITY_RECEIPT",
  schema:1,
  podId:"KashKorner",
  shardHash:"a".repeat(64),
  previousReceiptHash:null,
  durability:["PRE_COMMIT_RECEIPT_ACK","WRITE_PENDING"],
  sequence:1
};
const signed = await authority.signReceipt(receipt);
assert.equal(await authority.verifyReceipt(signed), true, "valid authority signature should verify");
assert.equal(await authority.verifyReceipt({...signed, podId:"XShield"}), false, "modified receipt must fail");
const attacker = new OverseerAuthoritySignatureEngine();
await attacker.initAuthorityKey();
assert.equal(await authority.verifyReceipt({...signed, signerPubKey:await attacker.exportPublicKeyHex()}), false,
  "receipt cannot replace the pinned authority key");
assert.equal(await authority.verifyReceipt({...signed, signature:"00"}), false, "malformed signature must fail");
console.log(JSON.stringify({status:"ED25519_AUTHORITY_TESTS_PASSED",
  checks:["valid-signature","tamper-rejected","untrusted-key-rejected","malformed-signature-rejected"]}));
