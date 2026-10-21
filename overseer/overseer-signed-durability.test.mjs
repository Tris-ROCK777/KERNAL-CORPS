import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {webcrypto} from "node:crypto";
import {OverseerAuthoritySignatureEngine} from "./overseer-authority-signatures.mjs";
import {OverseerDurabilityBridge} from "./overseer-durability-bridge.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const dir = await mkdtemp(join(tmpdir(),"kernel-signed-wal-"));
const walPath = join(dir,"ring-wal.jsonl");
try {
  const authority = new OverseerAuthoritySignatureEngine();
  await authority.initAuthorityKey();
  const bridge = new OverseerDurabilityBridge({}, {
    target:"node", walPath, authoritySignatureEngine:authority, requireAuthoritySignature:true
  });
  await bridge.init();
  const commit = {op:"HOTSWAP_COMMIT",podId:"KashKorner",hash:"b".repeat(64),
    signature:"test-code-signature",algorithm:"TEST-ONLY",origin:"LOCAL",ts:Date.now()};
  await bridge.appendCommitReceipt(commit);
  await bridge.appendTerminalReceipt(commit,"HOTSWAP_COMMIT_RECEIPT");
  const valid = await bridge.verifyReceiptChain();
  assert.equal(valid.valid,true,JSON.stringify(valid));
  assert.equal(valid.records,2);
  assert.ok(valid.receiptRecords.every(row=>typeof row.signature==="string" && row.signerPubKey));
  const original = await readFile(walPath,"utf8");
  const rows = original.trim().split("\n").map(line=>JSON.parse(line));
  rows[0].podId = "XShield";
  await writeFile(walPath,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
  const tampered = await bridge.verifyReceiptChain();
  assert.equal(tampered.valid,false,"tampered signed receipt must fail verification");
  console.log(JSON.stringify({status:"SIGNED_DURABILITY_RECEIPTS_PASSED",
    checks:["commit-and-terminal-receipts-signed","pinned-authority-signatures-verified","tampering-rejected"]}));
} finally { await rm(dir,{recursive:true,force:true}); }
