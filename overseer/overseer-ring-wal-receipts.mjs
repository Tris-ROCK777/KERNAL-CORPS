/**
 * KERNEL CORP. — Ring-WAL durability receipt bridge.
 *
 * Install after OverseerHotSwap.init() and before attaching peers to
 * OverseerMeshReplicator. Every HOTSWAP_COMMIT written by the engine
 * (local/outgoing or peer/incoming) is followed by a hash-linked receipt
 * in the same OPFS ring-wal.jsonl. No server path is assumed in browsers.
 *
 * Receipt failure is surfaced to the caller; it is never silently reported
 * as durable. The underlying commit row may already exist if receipt writing
 * fails, so recovery must treat missing receipts as incomplete durability.
 */
const RECEIPT_OP = "HOTSWAP_DURABILITY_RECEIPT";
const HEX_256 = /^[a-f0-9]{64}$/;

const toHex = bytes => [...new Uint8Array(bytes)]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value) {
  return toHex(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
  ));
}

export function installRingWalDurabilityReceipts(engine) {
  if (!engine || typeof engine.appendRingWAL !== "function" || !engine.root) {
    throw new Error("INITIALIZED_HOTSWAP_ENGINE_REQUIRED");
  }
  if (engine.__ringWalReceiptBridge) return engine.__ringWalReceiptBridge;

  const appendOriginal = engine.appendRingWAL.bind(engine);
  let chain = Promise.resolve();
  let receiptSequence = 0;

  const appendReceipt = async commit => {
    // Find the latest receipt hash from the persisted WAL so a page restart
    // continues the chain rather than starting a new one.
    let previousReceiptHash = null;
    try {
      const handle = await engine.root.getFileHandle("ring-wal.jsonl");
      const lines = (await (await handle.getFile()).text()).split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        try {
          const row = JSON.parse(lines[i]);
          if (row.op === RECEIPT_OP && HEX_256.test(row.receiptHash || "")) {
            previousReceiptHash = row.receiptHash;
            break;
          }
        } catch { /* ignore torn WAL rows; engine recovery handles them */ }
      }
    } catch { /* no WAL yet; first receipt anchors at null */ }

    const payload = {
      op: RECEIPT_OP,
      schema: 1,
      commitOp: "HOTSWAP_COMMIT",
      podId: commit.podId,
      shardHash: commit.hash,
      signature: commit.signature,
      algorithm: commit.algorithm,
      origin: commit.origin || "unknown",
      peerId: commit.peerId || null,
      transferId: commit.transferId || null,
      previousReceiptHash,
      sequence: ++receiptSequence,
      committedAt: Number.isFinite(commit.ts) ? commit.ts : Date.now()
    };
    payload.receiptHash = await sha256(payload);
    await appendOriginal(payload);
    return {
      status: "DURABILITY_RECEIPT_PERSISTED",
      podId: payload.podId,
      shardHash: payload.shardHash,
      receiptHash: payload.receiptHash,
      previousReceiptHash
    };
  };

  engine.appendRingWAL = entry => {
    const task = chain.then(async () => {
      await appendOriginal(entry);
      if (entry?.op === "HOTSWAP_COMMIT") {
        return appendReceipt(entry);
      }
      return {status: "WAL_ROW_PERSISTED", op: entry?.op || null};
    });
    // Preserve order but allow later writes after an individual failed operation.
    chain = task.catch(() => {});
    return task;
  };

  const bridge = {
    async flush() { await chain; await engine.walQueue; },
    uninstall() {
      engine.appendRingWAL = appendOriginal;
      delete engine.__ringWalReceiptBridge;
    }
  };
  Object.defineProperty(engine, "__ringWalReceiptBridge", {
    value: bridge, configurable: true, enumerable: false
  });
  return bridge;
}

/** Optional verification utility for diagnostics/tests. */
export async function verifyReceiptChain(walText) {
  const rows = [];
  for (const line of String(walText).split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      if (row.op === RECEIPT_OP) rows.push(row);
    } catch { /* torn/non-JSON line is not a receipt */ }
  }
  let previous = null;
  for (const row of rows) {
    const {receiptHash, ...payload} = row;
    if (row.previousReceiptHash !== previous) {
      return {status:"RECEIPT_CHAIN_INVALID", count:rows.length, badReceiptHash:receiptHash, reason:"PREVIOUS_HASH_MISMATCH"};
    }
    if (await sha256(payload) !== receiptHash) {
      return {status:"RECEIPT_CHAIN_INVALID", count:rows.length, badReceiptHash:receiptHash, reason:"RECEIPT_HASH_MISMATCH"};
    }
    previous = receiptHash;
  }
  return {status:"RECEIPT_CHAIN_VALID", count:rows.length, lastReceiptHash:previous};
}
