import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {OverseerDurabilityBridge} from "./overseer-durability-bridge.mjs";
import {inspectAndRecoverRingWAL} from "./overseer-recovery-inspector.mjs";

const sha = s => createHash("sha256").update(s).digest("hex");
const dir = await mkdtemp(join(tmpdir(), "kernel-recovery-"));
try {
  const bridge = new OverseerDurabilityBridge({}, {target:"node", walPath:join(dir,"ring-wal.jsonl")});
  await bridge.init();
  const commit = {op:"HOTSWAP_COMMIT", podId:"KashKorner", hash:sha("recovery-test-shard"),
    signature:"test-only", algorithm:"TEST-ONLY", origin:"local", ts:Date.now()};
  // Simulate abrupt process termination after durable pre-commit receipt but before terminal receipt.
  await bridge.appendCommitReceipt(commit);
  const before = await bridge.verifyReceiptChain();
  assert.equal(before.valid, true);
  assert.equal(before.headRecord.op, "HOTSWAP_DURABILITY_RECEIPT");
  assert.ok(before.headRecord.durability.includes("WRITE_PENDING"));

  const quarantinedPods = [];
  const result = await inspectAndRecoverRingWAL(bridge, {
    quarantinePod: async (podId, details) => quarantinedPods.push({podId, details})
  });
  assert.equal(result.chainValid, true);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].podId, "KashKorner");
  assert.equal(quarantinedPods.length, 1);
  const after = await bridge.verifyReceiptChain();
  assert.equal(after.valid, true);
  assert.equal(after.headRecord.op, "HOTSWAP_FORCED_ABORT_RECEIPT");
  assert.equal(after.headRecord.reason, "SYSTEM_RESTART_UNRESOLVED_PRE_COMMIT");
  console.log(JSON.stringify({
    status:"DANGLING_PRECOMMIT_RECOVERY_PASSED",
    checks:["pending-receipt-detected","forced-abort-appended","pod-quarantine-hook-called","chain-valid-after-recovery"],
    quarantined:result.quarantined.length
  }));
} finally {
  await rm(dir,{recursive:true,force:true});
}
