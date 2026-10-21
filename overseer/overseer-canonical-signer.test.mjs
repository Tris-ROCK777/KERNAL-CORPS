import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {canonicalizeJson,signReceiptPayload,verifyReceiptPayload} from "./overseer-canonical-signer.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

async function runCryptographyTests() {
  const keyPair = await crypto.subtle.generateKey({name:"Ed25519"}, true, ["sign","verify"]);
  const baseReceipt = {
    op:"HOTSWAP_DURABILITY_RECEIPT",
    podId:"KashKorner",
    hash:"743ef50a8a4a07d90d4c32f7dde33651e46a071611afd4c215684465a46fd45c",
    ts:1776820000000
  };

  // Key order and excluded signature field must not change canonical bytes.
  assert.equal(canonicalizeJson({z:1,a:2,signature:"fake"}), canonicalizeJson({a:2,z:1}));
  assert.equal(canonicalizeJson({outer:{z:1,signature:"nested",a:2}}), '{"outer":{"a":2,"z":1}}');

  const signed = await signReceiptPayload(baseReceipt,keyPair.privateKey);
  assert.equal(await verifyReceiptPayload(signed,keyPair.publicKey),true);
  assert.equal(await verifyReceiptPayload({...signed,hash:"CORRUPTED_HASH_VALUE"},keyPair.publicKey),false);

  const other = await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);
  assert.equal(await verifyReceiptPayload(signed,other.publicKey),false,"untrusted public key must reject receipt");
  assert.equal(await verifyReceiptPayload({...signed,signature:"00"},keyPair.publicKey),false,"malformed signature must reject");
  assert.throws(()=>canonicalizeJson({x:undefined}),/UNDEFINED_FIELD/);
  assert.throws(()=>canonicalizeJson({x:Infinity}),/NONFINITE_NUMBER/);
  const cyclic={}; cyclic.self=cyclic;
  assert.throws(()=>canonicalizeJson(cyclic),/CYCLE/);

  console.log(JSON.stringify({status:"CANONICAL_SIGNER_TESTS_PASSED",
    checks:["sorted-keys","nested-signature-exclusion","valid-signature","tamper-rejection",
      "untrusted-key-rejection","malformed-signature-rejection","unsupported-json-rejected"]}));
}
runCryptographyTests().catch(error=>{console.error("CRYPTOGRAPHY_TEST_SUITE_FAILED",error);process.exit(1);});
