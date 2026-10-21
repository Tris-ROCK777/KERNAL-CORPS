import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, mkdir, appendFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {OverseerDurabilityBridge, installDurabilityBridge} from "./overseer-durability-bridge.mjs";

const dir = await mkdtemp(join(tmpdir(), "kernel-ring-wal-"));
const walPath = join(dir, "ring-wal.jsonl");
try {
  const engine = {
    async appendRingWAL(entry) {
      await mkdir(dirname(walPath), {recursive:true});
      await appendFile(walPath, JSON.stringify({...entry, ts:entry.ts || Date.now()}) + "\n", "utf8");
      return {status:"WAL_ROW_PERSISTED"};
    }
  };
  const bridge = new OverseerDurabilityBridge(engine, {target:"node", walPath});
  await bridge.init();
  const hook = installDurabilityBridge(engine, bridge);
  const shardHashA = "a".repeat(64);
  const shardHashB = "b".repeat(64);

  // Local mutation commit and peer-originated commit both use the same boundary.
  await engine.appendRingWAL({op:"HOTSWAP_COMMIT", podId:"KernelVision", hash:shardHashA,
    signature:"local-signature", algorithm:"ECDSA-P256", origin:"local", ts:1001});
  await engine.appendRingWAL({op:"HOTSWAP_COMMIT", podId:"KashKorner", hash:shardHashB,
    signature:"peer-signature", algorithm:"ECDSA-P256", origin:"peer", peerId:"peer-01",
    transferId:"0123456789ab", ts:1002});
  await hook.flush();

  const status = await bridge.verifyReceiptChain();
  assert.equal(status.valid, true, JSON.stringify(status));
  assert.equal(status.records, 4); // two commits each produce a pre-commit and terminal receipt
  const rows = (await readFile(walPath, "utf8")).trim().split("\n").map(JSON.parse);
  const receipts = rows.filter(row => row.op === "HOTSWAP_DURABILITY_RECEIPT");
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].previousReceiptHash, null);
  assert.equal(receipts[1].previousReceiptHash, receipts[0].receiptHash);
  assert.equal(receipts[0].shardHash, shardHashA);
  assert.equal(receipts[1].shardHash, shardHashB);
  assert.equal(receipts[1].peerId, "peer-01");

  // Restart the bridge and verify the persisted chain is still valid.
  const restarted = new OverseerDurabilityBridge(null, {target:"node", walPath});
  await restarted.init();
  const recovered = await restarted.verifyReceiptChain();
  assert.equal(recovered.valid, true);
  assert.equal(recovered.records, 4); // persisted pre-commit and terminal receipts survive restart

  // Tampering with a receipt must invalidate the chain.
  rows.find(row => row.op === "HOTSWAP_DURABILITY_RECEIPT").podId = "tampered";
  await (await import("node:fs/promises")).writeFile(walPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const tampered = await restarted.verifyReceiptChain();
  assert.equal(tampered.valid, false);

  hook.uninstall();
  console.log(JSON.stringify({
    status:"DUAL_TARGET_DURABILITY_E2E_PASSED",
    checks:["local_commit_receipt","peer_commit_receipt","hash_link_order","restart_recovery","tamper_detection"],
    receipts:2
  }));
} finally {
  await rm(dir, {recursive:true, force:true});
}
