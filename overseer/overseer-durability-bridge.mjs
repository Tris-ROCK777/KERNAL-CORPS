/**
 * KERNEL CORP. — Dual-target append-only durability bridge.
 *
 * Browser: OPFS ring-wal.jsonl.
 * Node:    /srv/apex/se-x/projects/ring-wal.jsonl (or RING_WAL_PATH).
 *
 * This module is deliberately independent of the browser-only HotSwap engine.
 * Call appendCommitReceipt() at the authoritative commit boundary, after the
 * HOTSWAP_COMMIT has been accepted. Do not use a fire-and-forget event listener
 * for durability: callers must await the returned receipt.
 */
const RECEIPT_OP = "HOTSWAP_DURABILITY_RECEIPT";
const COMMIT_OP = "HOTSWAP_COMMIT";
const DEFAULT_NODE_PATH = "/srv/apex/se-x/projects/ring-wal.jsonl";
const HEX_256 = /^[a-f0-9]{64}$/;

const canonicalJSON = value => JSON.stringify(value);
const hex = bytes => [...new Uint8Array(bytes)]
  .map(b => b.toString(16).padStart(2, "0")).join("");

async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) return hex(await crypto.subtle.digest("SHA-256", bytes));
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeRuntime() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

export class OverseerDurabilityBridge {
  constructor(hotSwapEngine, options = {}) {
    this.engine = hotSwapEngine;
    this.authoritySignatureEngine = options.authoritySignatureEngine || null;
    this.requireAuthoritySignature = options.requireAuthoritySignature ?? Boolean(this.authoritySignatureEngine);
    this.target = options.target || (isNodeRuntime() ? "node" : "opfs");
    this.walPath = options.walPath || (typeof process !== "undefined"
      ? process.env?.RING_WAL_PATH || DEFAULT_NODE_PATH : DEFAULT_NODE_PATH);
    this.root = options.root || null;
    this.fs = null;
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    if (this.target === "node") {
      if (!isNodeRuntime()) throw new Error("NODE_TARGET_REQUIRES_NODE_RUNTIME");
      this.fs = await import("node:fs/promises");
      await this.fs.mkdir((await import("node:path")).dirname(this.walPath), {recursive:true});
      // Open/create without truncating existing append-only history.
      const handle = await this.fs.open(this.walPath, "a");
      await handle.close();
    } else if (this.target === "opfs") {
      if (!globalThis.navigator?.storage?.getDirectory) {
        throw new Error("OPFS_UNAVAILABLE: use secure browser context or target=node");
      }
      this.root = this.root || await navigator.storage.getDirectory();
    } else {
      throw new Error("UNKNOWN_DURABILITY_TARGET");
    }
    this.initialized = true;
    return this;
  }

  async readWalText() {
    if (!this.initialized) throw new Error("DURABILITY_BRIDGE_NOT_INITIALIZED");
    if (this.target === "node") {
      try { return await this.fs.readFile(this.walPath, "utf8"); }
      catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
    }
    try {
      const handle = await this.root.getFileHandle("ring-wal.jsonl");
      return await (await handle.getFile()).text();
    } catch (error) {
      if (error?.name === "NotFoundError") return "";
      throw error;
    }
  }

  async appendLine(record) {
    if (!this.initialized) throw new Error("DURABILITY_BRIDGE_NOT_INITIALIZED");
    const line = canonicalJSON(record) + "\n";
    if (this.target === "node") {
      // Append-only; sync the file before acknowledging durability.
      const handle = await this.fs.open(this.walPath, "a");
      try { await handle.writeFile(line, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      return;
    }
    const handle = await this.root.getFileHandle("ring-wal.jsonl", {create:true});
    const writable = await handle.createWritable({keepExistingData:true});
    try {
      const file = await handle.getFile();
      await writable.seek(file.size);
      await writable.write(line);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch {}
      throw error;
    }
  }

  async appendCommitReceipt(commit, metadata = {}) {
    if (!commit || commit.op !== COMMIT_OP) throw new Error("HOTSWAP_COMMIT_REQUIRED");
    if (!commit.hash || !HEX_256.test(commit.hash)) throw new Error("VALID_SHA256_SHARD_HASH_REQUIRED");

    const operation = this.queue.then(async () => {
      const existingText = await this.readWalText();
      let previousReceiptHash = null;
      let sequence = 0;
      for (const line of existingText.split("\n")) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); }
        catch { continue; } // preserve existing WAL; malformed lines are not receipts
        if ([RECEIPT_OP, "HOTSWAP_COMMIT_RECEIPT", "HOTSWAP_ABORT_RECEIPT", "HOTSWAP_FORCED_ABORT_RECEIPT"].includes(row.op)) {
          if (!HEX_256.test(row.receiptHash || "")) {
            throw new Error("DURABILITY_CHAIN_BROKEN: malformed prior receipt hash");
          }
          previousReceiptHash = row.receiptHash;
          sequence = Math.max(sequence, Number(row.sequence) || 0);
        }
      }

      const payload = {
        op: RECEIPT_OP,
        schema: 1,
        commitOp: COMMIT_OP,
        durability: ["PRE_COMMIT_RECEIPT_ACK", "WRITE_PENDING"],
        podId: commit.podId ?? null,
        shardHash: commit.hash,
        commitSignature: commit.signature ?? null,
        algorithm: commit.algorithm ?? null,
        origin: metadata.origin || commit.origin || "unknown",
        peerId: metadata.peerId || commit.peerId || null,
        transferId: metadata.transferId || commit.transferId || null,
        previousReceiptHash,
        sequence: sequence + 1,
        committedAt: Number.isFinite(commit.ts) ? commit.ts : Date.now()
      };
      const receiptHash = await digest(canonicalJSON(payload));
      let record = {...payload, receiptHash};
      if (this.authoritySignatureEngine) record = await this.authoritySignatureEngine.signReceipt(record);
      else if (this.requireAuthoritySignature) throw new Error("AUTHORITY_SIGNATURE_ENGINE_REQUIRED");
      await this.appendLine(record);
      return {status:"DURABILITY_RECEIPT_PERSISTED", target:this.target,
        sequence:record.sequence, shardHash:record.shardHash, receiptHash,
        previousReceiptHash};
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async appendAbortReceipt(commit, reason, metadata = {}) {
    const operation = this.queue.then(async () => {
      const existingText = await this.readWalText();
      let previousReceiptHash = null;
      let sequence = 0;
      for (const line of existingText.split("\n")) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if ([RECEIPT_OP, "HOTSWAP_COMMIT_RECEIPT", "HOTSWAP_ABORT_RECEIPT", "HOTSWAP_FORCED_ABORT_RECEIPT"].includes(row.op)) {
          if (!HEX_256.test(row.receiptHash || "")) {
            throw new Error("DURABILITY_CHAIN_BROKEN: malformed prior receipt hash");
          }
          previousReceiptHash = row.receiptHash;
          sequence = Math.max(sequence, Number(row.sequence) || 0);
        }
      }
      const payload = {
        op:"HOTSWAP_ABORT_RECEIPT",
        schema:1,
        podId:commit.podId ?? null,
        failedShardHash:commit.hash,
        previousReceiptHash,
        sequence:sequence + 1,
        reason:String(reason || "ENGINE_COMMIT_FAILED"),
        origin:metadata.origin || commit.origin || "unknown",
        abortedAt:Date.now()
      };
      const receiptHash = await digest(canonicalJSON(payload));
      let record = {...payload, receiptHash};
      if (this.authoritySignatureEngine) record = await this.authoritySignatureEngine.signReceipt(record);
      else if (this.requireAuthoritySignature) throw new Error("AUTHORITY_SIGNATURE_ENGINE_REQUIRED");
      await this.appendLine(record);
      return {status:"DURABILITY_ABORT_RECEIPT_PERSISTED", receiptHash, previousReceiptHash};
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async appendTerminalReceipt(commit, op = "HOTSWAP_COMMIT_RECEIPT", metadata = {}) {
    if (op !== "HOTSWAP_COMMIT_RECEIPT" && op !== "HOTSWAP_ABORT_RECEIPT" &&
        op !== "HOTSWAP_FORCED_ABORT_RECEIPT") throw new Error("INVALID_TERMINAL_RECEIPT_OP");
    const operation = this.queue.then(async () => {
      const existingText = await this.readWalText();
      let previousReceiptHash = null;
      let sequence = 0;
      for (const line of existingText.split("\n")) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if ([RECEIPT_OP, "HOTSWAP_COMMIT_RECEIPT", "HOTSWAP_ABORT_RECEIPT", "HOTSWAP_FORCED_ABORT_RECEIPT"].includes(row.op)) {
          if (!HEX_256.test(row.receiptHash || "")) throw new Error("DURABILITY_CHAIN_BROKEN");
          previousReceiptHash = row.receiptHash;
          sequence = Math.max(sequence, Number(row.sequence) || 0);
        }
      }
      const payload = {
        op, schema:1, podId:commit.podId ?? null,
        shardHash:commit.hash ?? commit.shardHash ?? commit.failedShardHash ?? null,
        previousReceiptHash, sequence:sequence + 1,
        reason:metadata.reason || commit.reason || null,
        origin:metadata.origin || commit.origin || "unknown",
        ts:Date.now()
      };
      const receiptHash = await digest(canonicalJSON(payload));
      let record = {...payload, receiptHash};
      if (this.authoritySignatureEngine) record = await this.authoritySignatureEngine.signReceipt(record);
      else if (this.requireAuthoritySignature) throw new Error("AUTHORITY_SIGNATURE_ENGINE_REQUIRED");
      await this.appendLine(record);
      return {status:"TERMINAL_RECEIPT_PERSISTED", op, receiptHash, previousReceiptHash, sequence:record.sequence};
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async verifyReceiptChain() {
    const text = await this.readWalText();
    let previous = null;
    let count = 0;
    for (const line of text.split("\n").filter(Boolean)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (![RECEIPT_OP, "HOTSWAP_COMMIT_RECEIPT", "HOTSWAP_ABORT_RECEIPT", "HOTSWAP_FORCED_ABORT_RECEIPT"].includes(row.op)) continue;
      const {receiptHash, signature:authoritySignature, signerPubKey, ...payload} = row;
      if (!HEX_256.test(receiptHash || "") || row.previousReceiptHash !== previous) {
        return {valid:false, records:count, reason:"PREVIOUS_HASH_OR_FORMAT_MISMATCH"};
      }
      if (await digest(canonicalJSON(payload)) !== receiptHash) {
        return {valid:false, records:count, reason:"RECEIPT_HASH_MISMATCH", badReceiptHash:receiptHash};
      }
      if (this.requireAuthoritySignature && (!authoritySignature || !signerPubKey ||
          !await this.authoritySignatureEngine?.verifyReceipt(row))) {
        return {valid:false, records:count, reason:"AUTHORITY_SIGNATURE_INVALID_OR_UNTRUSTED", badReceiptHash:receiptHash};
      }
      previous = receiptHash;
      count++;
    }
    const rows = [];
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if ([RECEIPT_OP, "HOTSWAP_COMMIT_RECEIPT", "HOTSWAP_ABORT_RECEIPT", "HOTSWAP_FORCED_ABORT_RECEIPT"].includes(row.op)) rows.push(row);
      } catch {}
    }
    return {valid:true, records:count, lastReceiptHash:previous, headRecord:rows.at(-1) || null, receiptRecords:rows, target:this.target};
  }

  async flush() { await this.queue; }
}

/**
 * Install at the engine's appendRingWAL boundary. A commit is not acknowledged
 * as durable until both its original WAL append and its receipt have succeeded.
 * Use this only when engine.appendRingWAL is the canonical commit boundary.
 */
export function installDurabilityBridge(engine, bridge) {
  if (!engine || typeof engine.appendRingWAL !== "function") {
    throw new Error("ENGINE_APPEND_RING_WAL_REQUIRED");
  }
  const original = engine.appendRingWAL.bind(engine);
  let queue = Promise.resolve();
  engine.appendRingWAL = entry => {
    const task = queue.then(async () => {
      // Persist the pre-commit receipt before the canonical engine WAL.
      if (entry?.op !== COMMIT_OP) return original(entry);
      await bridge.appendCommitReceipt(entry, {origin:entry.origin, peerId:entry.peerId, transferId:entry.transferId});
      try {
        const result = await original(entry);
        await bridge.appendTerminalReceipt(entry, "HOTSWAP_COMMIT_RECEIPT", {origin:entry.origin});
        return result;
      } catch (error) {
        // The pending receipt remains visible if both engine write and abort receipt fail.
        try {
          await bridge.appendTerminalReceipt(entry, "HOTSWAP_ABORT_RECEIPT", {
            origin:entry.origin, reason:error?.message || String(error)
          });
        } catch (abortError) {
          error.abortReceiptError = abortError;
        }
        throw error;
      }
    });
    queue = task.catch(() => {});
    return task;
  };
  return {
    async flush() { await queue; await bridge.flush(); },
    uninstall() { engine.appendRingWAL = original; }
  };
}
