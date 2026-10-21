import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {OverseerDurabilityBridge} from "./overseer-durability-bridge.mjs";
import {OverseerAuthoritativeCommitPipeline} from "./overseer-authoritative-commit-pipeline.mjs";

const sha = s => createHash("sha256").update(s).digest("hex");
const dir = await mkdtemp(join(tmpdir(), "kernel-durability-race-"));
const walPath = join(dir, "receipts.jsonl");
try {
  const engineLog = [];
  const pods = new Map();
  let failEngineAppend = false;
  const engine = {
    async appendRingWAL(entry) {
      if (failEngineAppend && entry?.op === "HOTSWAP_COMMIT") throw new Error("SIMULATED_ENGINE_WAL_FAILURE");
      engineLog.push(structuredClone(entry));
    },
    async mutatePod(podId, codeString, {signature, origin}) {
      const entry = {op:"HOTSWAP_COMMIT", podId, hash:sha(codeString), signature,
        algorithm:"TEST-ONLY", origin, ts:Date.now()};
      await this.appendRingWAL(entry);
      pods.set(podId, codeString);
      return {status:"COMMITTED", podId, hash:entry.hash};
    }
  };
  const bridge = new OverseerDurabilityBridge(engine, {target:"node", walPath});
  const pipeline = new OverseerAuthoritativeCommitPipeline(engine, {bridge});
  await pipeline.init();

  const codeA = 'export function mountPod() { return "Race-A"; }';
  const codeB = 'export function mountPod() { return "Race-B"; }';
  const race = await Promise.allSettled([
    pipeline.commitMutation("KashKorner", codeA, {signature:"test-A", source:"LOCAL"}),
    pipeline.commitMutation("KashKorner", codeB, {signature:"test-B", source:"LOCAL"})
  ]);
  assert.ok(race.every(r => r.status === "fulfilled"), "both serialized competing commits should succeed");
  const chainBefore = await pipeline.verifyReceiptChain();
  assert.equal(chainBefore.valid, true, JSON.stringify(chainBefore));
  assert.equal(chainBefore.records, 2);

  // TEST 2 — receipt persists, but the engine WAL fails afterward.
  failEngineAppend = true;
  let engineFailureRejected = false;
  try {
    await pipeline.commitMutation("XShield", 'export function mountPod() { return "Engine-Fault"; }',
      {signature:"engine-fault", source:"LOCAL"});
  } catch (e) {
    engineFailureRejected = String(e?.message).includes("SIMULATED_ENGINE_WAL_FAILURE");
  } finally {
    failEngineAppend = false;
  }
  assert.equal(engineFailureRejected, true, "engine WAL failure must reject commit");
  assert.equal(pods.has("XShield"), false, "failed engine commit must not publish pod state");
  const afterAbort = await pipeline.verifyReceiptChain();
  assert.equal(afterAbort.valid, true, JSON.stringify(afterAbort));
  assert.equal(afterAbort.records, 3, "failed engine write must append a linked abort receipt");

  // TEST 3 — a receipt-store failure must stop before engine WAL and pod state.
  const logBefore = engineLog.length;
  const priorPod = pods.get("KashKorner");
  const originalAppend = bridge.appendCommitReceipt.bind(bridge);
  bridge.appendCommitReceipt = async () => { throw new Error("SIMULATED_ENOSPC_OR_WRITE_FAILURE"); };
  let rejected = false;
  try {
    await pipeline.commitMutation("XShield", 'export function mountPod() { return "Fault-Test"; }',
      {signature:"test-fault", source:"LOCAL"});
  } catch (e) {
    rejected = /SIMULATED_ENOSPC_OR_WRITE_FAILURE|DURABILITY/.test(String(e?.message));
  } finally { bridge.appendCommitReceipt = originalAppend; }

  assert.equal(rejected, true, "receipt write failure must reject commit");
  assert.equal(engineLog.length, logBefore, "receipt failure must not append engine WAL row");
  assert.equal(pods.has("XShield"), false, "receipt failure must not publish failed pod");
  assert.equal(pods.get("KashKorner"), priorPod);
  const final = await pipeline.verifyReceiptChain();
  assert.equal(final.valid, true, JSON.stringify(final));
  assert.equal(final.records, chainBefore.records);
  assert.equal(final.lastReceiptHash, chainBefore.lastReceiptHash);
  pipeline.dispose();
  console.log(JSON.stringify({status:"CONCURRENCY_AND_FAULT_INVARIANTS_PASSED",
    checks:["same-pod-race","engine-wal-failure-adds-abort-receipt","receipt-write-failure-aborts-before-engine-wal","pod-state-unchanged","chain-head-preserved"],
    totalRecords:final.records}));
} finally { await rm(dir, {recursive:true, force:true}); }
