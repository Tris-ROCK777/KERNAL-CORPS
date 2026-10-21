/**
 * KERNEL CORP. — Ring-WAL recovery inspector.
 * Detects pre-commit receipts with no terminal outcome and quarantines them.
 * It does not claim to roll back engine state unless a rollback adapter is supplied.
 */
export async function inspectAndRecoverRingWAL(bridge, options = {}) {
  const chainStatus = await bridge.verifyReceiptChain();
  if (!chainStatus.valid) {
    throw new Error(`CRITICAL: Chain corruption detected: ${chainStatus.reason || "UNKNOWN"}`);
  }

  const records = chainStatus.receiptRecords || [];
  const pending = new Map();
  const terminalOps = new Set([
    "HOTSWAP_COMMIT_RECEIPT",
    "HOTSWAP_ABORT_RECEIPT",
    "HOTSWAP_FORCED_ABORT_RECEIPT"
  ]);

  for (const row of records) {
    if (row.op === "HOTSWAP_DURABILITY_RECEIPT") {
      pending.set(row.receiptHash, row);
    } else if (terminalOps.has(row.op)) {
      const parent = row.previousReceiptHash;
      if (parent) pending.delete(parent);
    }
  }

  const unresolved = [...pending.values()].filter(row =>
    Array.isArray(row.durability) && row.durability.includes("WRITE_PENDING")
  );
  const quarantined = [];
  for (const row of unresolved) {
    const terminal = await bridge.appendTerminalReceipt({
      podId:row.podId,
      hash:row.shardHash,
      reason:"SYSTEM_RESTART_UNRESOLVED_PRE_COMMIT"
    }, "HOTSWAP_FORCED_ABORT_RECEIPT", {
      reason:"SYSTEM_RESTART_UNRESOLVED_PRE_COMMIT"
    });
    quarantined.push({
      podId:row.podId,
      unresolvedReceiptHash:row.receiptHash,
      quarantineReceiptHash:terminal.receiptHash,
      status:"UNCOMMITTED_QUARANTINED"
    });
    if (typeof options.quarantinePod === "function") {
      await options.quarantinePod(row.podId, {
        reason:"SYSTEM_RESTART_UNRESOLVED_PRE_COMMIT",
        shardHash:row.shardHash
      });
    }
  }

  const finalStatus = await bridge.verifyReceiptChain();
  if (!finalStatus.valid) {
    throw new Error("CRITICAL: Chain invalid after recovery: " + finalStatus.reason);
  }
  return {
    recovered:true,
    quarantined,
    lastValidHash:finalStatus.lastReceiptHash,
    chainValid:finalStatus.valid,
    note:"Quarantine is recorded; physical engine rollback requires a supplied engine adapter."
  };
}
