/**
 * KERNEL CORP — Overseer Hot-Swap Engine (browser prototype)
 * No runtime dependencies. Requires a secure context with OPFS + WebCrypto.
 *
 * Security boundary: the Worker gate is a smoke-test/isolation from the UI thread,
 * NOT a hostile-code sandbox. Only install code from a trusted signing authority.
 */
import { isSupportedPodId } from "./overseer-pod-identifiers.mjs";

const hex = bytes => [...new Uint8Array(bytes)]
  .map(b => b.toString(16).padStart(2, "0")).join("");

export class OverseerHotSwap {
  constructor({ publicKey, signatureAlgorithm = "ECDSA-P256", timeoutMs = 1500 } = {}) {
    this.publicKey = publicKey;
    this.signatureAlgorithm = signatureAlgorithm;
    this.timeoutMs = timeoutMs;
    this.root = null;
    this.activePods = new Map();
    this.lkgPointers = new Map();
    this.commitListeners = new Set();
    // Serialize read-modify-write WAL appends so concurrent peer commits cannot overwrite each other.
    this.walQueue = Promise.resolve();
  }

  async init() {
    // Fail before touching persistent state if no independently provisioned trust root exists.
    if (!this.publicKey) throw new Error("PINNED_AUTHORITY_PUBLIC_KEY_REQUIRED");
    if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || !crypto?.subtle) {
      throw new Error("UNSUPPORTED_RUNTIME: secure context, OPFS and WebCrypto are required");
    }
    this.root = await navigator.storage.getDirectory();
    await this.recoverFromRestart();
    return this;
  }

  onCommit(listener) {
    if (typeof listener !== "function") throw new Error("COMMIT_LISTENER_REQUIRED");
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  emitCommit(event) {
    for (const listener of this.commitListeners) {
      try {
        Promise.resolve(listener(event)).catch(() => {});
      } catch { /* observers must not invalidate a durable local commit */ }
    }
  }

  async sha256(text) {
    return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  }

  async verifySignature(code, signatureHex, publicKey = this.publicKey) {
    if (!publicKey || !signatureHex) throw new Error("AUTH_REQUIRED: signed modules are mandatory");
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(signatureHex)) throw new Error("BAD_SIGNATURE_ENCODING");
    const signature = Uint8Array.from(signatureHex.match(/.{2}/g), b => parseInt(b, 16));
    const data = new TextEncoder().encode(code);
    let algorithm;
    if (this.signatureAlgorithm === "Ed25519") algorithm = { name: "Ed25519" };
    else if (this.signatureAlgorithm === "ECDSA-P256") algorithm = { name: "ECDSA", hash: "SHA-256" };
    else throw new Error("UNSUPPORTED_SIGNATURE_ALGORITHM");
    if (!await crypto.subtle.verify(algorithm, publicKey, signature, data)) {
      throw new Error("AUTH_FAILED: signature verification failed");
    }
    return true;
  }

  // This catches syntax/import/contract failures in a disposable worker.
  // It does not make arbitrary JavaScript safe; trust the signer.
  async runSandboxGate(code) {
    const source = `
      self.onmessage = async ({data: code}) => {
        let url;
        try {
          url = URL.createObjectURL(new Blob([code], {type:"text/javascript"}));
          const mod = await import(url);
          if (typeof mod.mountPod !== "function" && typeof mod.default !== "function") {
            throw new Error("Missing mountPod() or default() export");
          }
          self.postMessage({ok:true, exports:Object.keys(mod)});
        } catch (e) {
          self.postMessage({ok:false, error:String(e?.message || e)});
        } finally { if (url) URL.revokeObjectURL(url); }
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
    const worker = new Worker(workerUrl, {type:"module"});
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SANDBOX_TIMEOUT")), this.timeoutMs);
        worker.onmessage = e => {
          clearTimeout(timer);
          e.data.ok ? resolve(e.data) : reject(new Error("SANDBOX_REJECTED: " + e.data.error));
        };
        worker.onerror = e => { clearTimeout(timer); reject(new Error("SANDBOX_CRASH: " + e.message)); };
        worker.postMessage(code);
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  }

  async writeVerifiedShard(hash, code) {
    const dir = await this.root.getDirectoryHandle("shards", {create:true});
    const handle = await dir.getFileHandle(hash + ".mjs", {create:true});
    const writer = await handle.createWritable();
    try { await writer.write(code); await writer.close(); }
    catch (e) { try { await writer.abort(); } catch {} throw e; }
    const readBack = await (await handle.getFile()).text();
    if (await this.sha256(readBack) !== hash) {
      await dir.removeEntry(hash + ".mjs").catch(() => {});
      throw new Error("READ_BACK_SHA256_FAILED");
    }
    return readBack;
  }

  async appendRingWAL(entry) {
    const append = async () => {
      const handle = await this.root.getFileHandle("ring-wal.jsonl", {create:true});
      const previous = await (await handle.getFile()).text();
      const writer = await handle.createWritable();
      try {
        await writer.write(previous + JSON.stringify({...entry, ts:Date.now()}) + "\n");
        await writer.close();
      } catch (e) { try { await writer.abort(); } catch {} throw e; }
    };
    const pending = this.walQueue.then(append, append);
    // Keep the queue usable after a failed append while still surfacing that failure to its caller.
    this.walQueue = pending.catch(() => {});
    return pending;
  }

  async loadVerified(hash) {
    const dir = await this.root.getDirectoryHandle("shards");
    const handle = await dir.getFileHandle(hash + ".mjs");
    const code = await (await handle.getFile()).text();
    if (await this.sha256(code) !== hash) throw new Error("SHARD_HASH_MISMATCH");
    return code;
  }

  async mount(code) {
    const url = URL.createObjectURL(new Blob([code], {type:"text/javascript"}));
    try {
      const module = await import(url);
      return {objectUrl:url, module};
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  async mutatePod(podId, code, {signature, origin = "local"} = {}) {
    if (!isSupportedPodId(podId)) throw new Error("INVALID_POD: " + podId);
    await this.verifySignature(code, signature, this.publicKey);
    await this.runSandboxGate(code);
    const hash = await this.sha256(code);

    const previous = this.activePods.get(podId);
    const oldHash = previous?.hash ?? this.lkgPointers.get(podId) ?? null;
    // Stage and verify persistence inside the failure-recording boundary.
    // WAL commit happens before publishing the new active module.
    let candidate;
    try {
      await this.writeVerifiedShard(hash, code);
      candidate = await this.mount(code);
      await this.appendRingWAL({op:"HOTSWAP_COMMIT", podId, hash, lkgHash:oldHash, signature,
        algorithm:this.signatureAlgorithm,
        durability:["WRITE_ACK","READ_BACK_SHA256_PASS","RESTART_READY"]});
      this.activePods.set(podId, {hash, ...candidate});
      if (oldHash) this.lkgPointers.set(podId, oldHash);
      if (previous?.objectUrl) URL.revokeObjectURL(previous.objectUrl);
      const result = {status:"HOTSWAP_LIVE", podId, hash, rollbackAvailable:!!oldHash};
      this.emitCommit({
        ...result, codeString:code, signature,
        algorithm:this.signatureAlgorithm, origin
      });
      return result;
    } catch (e) {
      await this.appendRingWAL({op:"HOTSWAP_MOUNT_FAILED", podId, hash, retainedHash:oldHash, reason:String(e)});
      throw e;
    }
  }

  async rollbackPod(podId, {signature} = {}) {
    if (!isSupportedPodId(podId)) throw new Error("INVALID_POD: " + podId);
    const hash = this.lkgPointers.get(podId);
    if (!hash) throw new Error("NO_LKG_TARGET");
    if (!signature) {
      try {
        const wal = await this.root.getFileHandle("ring-wal.jsonl");
        const lines = (await (await wal.getFile()).text()).split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          // A torn/corrupt newer WAL row must not prevent finding an older signed LKG.
          let row;
          try { row = JSON.parse(lines[i]); } catch { continue; }
          if (row.op === "HOTSWAP_COMMIT" && row.podId === podId &&
              row.hash === hash && row.signature &&
              row.algorithm === this.signatureAlgorithm) {
            signature = row.signature; break;
          }
        }
      } catch {}
    }
    if (!signature) throw new Error("NO_LKG_SIGNATURE: cannot authenticate rollback target");
    const code = await this.loadVerified(hash);
    return this.mutatePod(podId, code, {signature});
  }

  async recoverFromRestart() {
    let text;
    try {
      const handle = await this.root.getFileHandle("ring-wal.jsonl");
      text = await (await handle.getFile()).text();
    } catch { return; }

    // Keep the commit history for each pod, newest first. If the newest entry
    // is corrupt or unauthenticated, recovery can fall back to an older verified
    // commit instead of leaving a previously valid pod unavailable.
    const commitsByPod = new Map();
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (row.op !== "HOTSWAP_COMMIT" || !isSupportedPodId(row.podId)) continue;
        if (!commitsByPod.has(row.podId)) commitsByPod.set(row.podId, []);
        commitsByPod.get(row.podId).push(row);
      } catch { /* ignore torn/corrupt WAL lines */ }
    }

    for (const [podId, commits] of commitsByPod) {
      for (let i = commits.length - 1; i >= 0; i--) {
        const row = commits[i];
        try {
          if (typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash)) {
            throw new Error("RECOVERY_BAD_SHARD_HASH");
          }
          if (row.algorithm !== this.signatureAlgorithm) {
            throw new Error("RECOVERY_SIGNATURE_ALGORITHM_MISMATCH");
          }
          const code = await this.loadVerified(row.hash);
          await this.verifySignature(code, row.signature, this.publicKey);
          await this.runSandboxGate(code);
          const mounted = await this.mount(code);
          this.activePods.set(podId, {hash:row.hash, ...mounted});
          if (typeof row.lkgHash === "string" && /^[0-9a-f]{64}$/.test(row.lkgHash)) {
            this.lkgPointers.set(podId, row.lkgHash);
          }
          break;
        } catch (e) {
          await this.appendRingWAL({op:"RECOVERY_REJECTED", podId, hash:row.hash, reason:String(e)});
        }
      }
    }
  }
}
