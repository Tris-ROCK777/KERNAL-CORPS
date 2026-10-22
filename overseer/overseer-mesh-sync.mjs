/**
 * KERNEL CORP. — OVERSEER WEBRTC MESH REPLICATOR (v2 HARDENED)
 * 16-byte binary framing, bounded payloads, guarded backpressure.
 */
const CHUNK_SIZE = 32 * 1024;
const HEADER_BYTES = 16;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_CHUNKS = 32;
const MAX_BUFFERED_AMOUNT = 256 * 1024;
const BACKPRESSURE_TIMEOUT_MS = 5_000;
const TRANSFER_TTL_MS = 15_000;
const MAX_INBOUND_TRANSFERS = 8;
import { isSupportedPodId } from "./overseer-pod-identifiers.mjs";

export class OverseerMeshReplicator {
  constructor(hotSwapEngine, authorityPublicKey, { authenticateInboundShard = null, signShardManifest = null } = {}) {
    if (!hotSwapEngine) throw new Error("MISSING_ENGINE");
    if (!hotSwapEngine.publicKey) throw new Error("MISSING_PINNED_ENGINE_AUTHORITY_KEY");
    if (!authorityPublicKey || authorityPublicKey !== hotSwapEngine.publicKey) {
      throw new Error("AUTHORITY_KEY_MISMATCH: mesh verifier must use the engine's pinned trust root");
    }
    this.engine = hotSwapEngine;
    // Durability is installed once by OverseerAuthoritativeCommitPipeline before peers attach.
    // Keep one trust root: outbound verification and inbound installation must agree.
    this.authorityPublicKey = hotSwapEngine.publicKey;
    this.authenticateInboundShard = authenticateInboundShard;
    this.signShardManifest = signShardManifest;
    this.peers = new Map();
    this.inboundBuffers = new Map();
    this.seenTransferIds = new Map();
    this.unsubscribeCommit = typeof this.engine.onCommit === "function"
      ? this.engine.onCommit(event => this.handleHotSwapCommit(event))
      : null;
  }

  async handleHotSwapCommit(event) {
    if (!event || event.origin !== "local") return;
    try {
      const results = await this.broadcastPodMutation({
        podId:event.podId, hash:event.hash, codeString:event.codeString,
        signature:event.signature, algorithm:event.algorithm
      });
      const failures = results.filter(result => result.status !== "SENT");
      if (failures.length) await this.log("MESH_AUTO_BROADCAST_PARTIAL", {
        podId:event.podId, hash:event.hash, failures
      });
    } catch (error) {
      await this.log("MESH_AUTO_BROADCAST_FAILED", {
        podId:event.podId, hash:event.hash, reason:String(error)
      });
    }
  }

  dispose() {
    if (this.unsubscribeCommit) this.unsubscribeCommit();
    this.unsubscribeCommit = null;
    for (const peerId of this.peers.keys()) this.detachPeerChannel(peerId);
  }

  generateTransferId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");
  }

  packBinaryChunk(transferId, chunkIndex, payload) {
    if (!/^[a-f0-9]{12}$/.test(transferId) || !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 || chunkIndex >= MAX_CHUNKS || payload.byteLength < 1 || payload.byteLength > CHUNK_SIZE) {
      throw new Error("INVALID_CHUNK_FRAME_FIELDS");
    }
    const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
    for (let i = 0; i < 12; i++) frame[i] = transferId.charCodeAt(i);
    new DataView(frame.buffer).setUint32(12, chunkIndex, false);
    frame.set(payload, HEADER_BYTES);
    return frame.buffer;
  }

  unpackBinaryChunk(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength <= HEADER_BYTES ||
        data.byteLength > HEADER_BYTES + CHUNK_SIZE) throw new Error("MALFORMED_BINARY_FRAME");
    const bytes = new Uint8Array(data);
    let transferId = "";
    for (let i = 0; i < 12; i++) {
      const c = bytes[i];
      if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) throw new Error("INVALID_TRANSFER_ID");
      transferId += String.fromCharCode(c);
    }
    return {transferId, chunkIndex:new DataView(data).getUint32(12, false), payload:bytes.slice(HEADER_BYTES)};
  }

  attachPeerChannel(peerId, channel) {
    if (!peerId || !channel) throw new Error("PEER_AND_CHANNEL_REQUIRED");
    this.detachPeerChannel(peerId);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = CHUNK_SIZE * 2;
    const onmessage = event => this.handleInboundFrame(peerId, event.data).catch(error =>
      this.log("MESH_FRAME_REJECTED", {peerId, reason:String(error)}));
    const cleanup = () => {
      if (this.peers.get(peerId)?.channel === channel) this.peers.delete(peerId);
      this.clearPeerTransfers(peerId);
    };
    channel.addEventListener("message", onmessage);
    channel.addEventListener("close", cleanup);
    channel.addEventListener("error", cleanup);
    this.peers.set(peerId, {channel, onmessage, cleanup});
  }

  detachPeerChannel(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.channel.removeEventListener("message", peer.onmessage);
    peer.channel.removeEventListener("close", peer.cleanup);
    peer.channel.removeEventListener("error", peer.cleanup);
    this.peers.delete(peerId);
    this.clearPeerTransfers(peerId);
  }

  clearPeerTransfers(peerId) {
    for (const [id, state] of this.inboundBuffers) if (state.peerId === peerId) this.dropTransfer(id);
  }

  async log(op, details) {
    try { await this.engine.appendRingWAL({op, ...details}); } catch {}
  }

  waitForDrain(channel) {
    if (channel.readyState !== "open") return Promise.reject(new Error("CHANNEL_NOT_OPEN"));
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onAbort);
        channel.removeEventListener("error", onAbort);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const onLow = () => {
        if (channel.readyState !== "open") return finish(new Error("CHANNEL_NOT_OPEN"));
        if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) finish();
      };
      const onAbort = () => finish(new Error("CHANNEL_ABORTED_DURING_BACKPRESSURE"));
      const timer = setTimeout(() => finish(new Error("BACKPRESSURE_DRAIN_TIMEOUT")), BACKPRESSURE_TIMEOUT_MS);
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onAbort);
      channel.addEventListener("error", onAbort);
      onLow();
    });
  }

  async broadcastPodMutation({podId, hash, codeString, signature, algorithm = this.engine.signatureAlgorithm || "ECDSA-P256"}) {
    if (!isSupportedPodId(podId)) throw new Error("INVALID_POD");
    if (typeof codeString !== "string" || !signature || !/^[a-f0-9]{64}$/i.test(hash || "")) throw new Error("INVALID_SIGNED_SHARD_METADATA");
    const bytes = new TextEncoder().encode(codeString);
    if (!bytes.byteLength || bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error("PAYLOAD_OUT_OF_BOUNDS");
    if (algorithm !== (this.engine.signatureAlgorithm || "ECDSA-P256")) throw new Error("SIGNATURE_ALGORITHM_POLICY_MISMATCH");
    if (typeof this.engine.verifySignature === "function") {
      await this.engine.verifySignature(codeString, signature, this.authorityPublicKey);
    } else {
      throw new Error("ENGINE_SIGNATURE_VERIFIER_REQUIRED");
    }
    const hashFn = this.engine.sha256 || this.engine.computeSHA256;
    if (typeof hashFn !== "function" || (await hashFn.call(this.engine, codeString)).toLowerCase() !== hash.toLowerCase()) throw new Error("OUTBOUND_HASH_MISMATCH");
    const shardSignature = this.signShardManifest ? await this.signShardManifest({bytes, podId, hash}) : null;
    if (this.authenticateInboundShard && !shardSignature) throw new Error("AUTHENTICATED_SHARD_SIGNATURE_REQUIRED");
    const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE);
    if (totalChunks > MAX_CHUNKS) throw new Error("CHUNK_COUNT_LIMIT");
    const results = [];
    for (const [peerId, peer] of this.peers) {
      const channel = peer.channel;
      if (channel.readyState !== "open") continue;
      const transferId = this.generateTransferId();
      try {
        channel.send(JSON.stringify({type:"OVERSEER_SHARD_HEADER", protocol:1, transferId, podId, hash, signature, shardSignature, algorithm, totalBytes:bytes.byteLength, totalChunks}));
        for (let i = 0; i < totalChunks; i++) {
          await this.waitForDrain(channel);
          if (channel.readyState !== "open") throw new Error("CHANNEL_CLOSED_DURING_TRANSFER");
          channel.send(this.packBinaryChunk(transferId, i, bytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.length))));
        }
        await this.waitForDrain(channel);
        if (channel.readyState !== "open") throw new Error("CHANNEL_CLOSED_BEFORE_EOF");
        channel.send(JSON.stringify({type:"OVERSEER_SHARD_EOF", transferId, expectedHash:hash}));
        results.push({peerId, transferId, status:"SENT", bytesSent:bytes.byteLength});
      } catch (error) { results.push({peerId, transferId, status:"FAILED", reason:String(error)}); }
    }
    return results;
  }

  async handleInboundFrame(peerId, data) {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { throw new Error("INVALID_JSON_FRAME"); }
      if (msg.type === "OVERSEER_SHARD_HEADER") return this.startTransfer(peerId, msg);
      if (msg.type === "OVERSEER_SHARD_EOF") return this.finishTransfer(peerId, msg);
      if (msg.type === "OVERSEER_SHARD_ACK") return this.log("MESH_AUTHENTICATED_ACK_RECEIVED", {peerId, transferId:msg.transferId, receipt:msg.receipt});
      throw new Error("UNKNOWN_CONTROL_FRAME");
    }
    const {transferId, chunkIndex, payload} = this.unpackBinaryChunk(data);
    const state = this.inboundBuffers.get(transferId);
    if (!state || state.peerId !== peerId) throw new Error("UNKNOWN_TRANSFER_OR_WRONG_PEER");
    if (chunkIndex >= state.meta.totalChunks || state.chunks[chunkIndex] !== null ||
        state.receivedBytes + payload.byteLength > state.meta.totalBytes) {
      this.dropTransfer(transferId);
      throw new Error("CHUNK_BOUNDS_OR_DUPLICATE");
    }
    const last = chunkIndex === state.meta.totalChunks - 1;
    if (!payload.byteLength || (!last && payload.byteLength !== CHUNK_SIZE)) {
      this.dropTransfer(transferId);
      throw new Error("INVALID_CHUNK_LENGTH");
    }
    state.chunks[chunkIndex] = payload;
    state.receivedChunks++;
    state.receivedBytes += payload.byteLength;
    this.refreshTtl(transferId, state);
  }

  startTransfer(peerId, meta) {
    if (meta.protocol !== 1 || typeof meta.transferId !== "string" || !/^[a-f0-9]{12}$/.test(meta.transferId) ||
        !isSupportedPodId(meta.podId) || !/^[a-f0-9]{64}$/i.test(meta.hash || "") ||
        typeof meta.signature !== "string" || !meta.signature || (this.authenticateInboundShard && (typeof meta.shardSignature !== "string" || !meta.shardSignature)) || !["Ed25519", "ECDSA-P256"].includes(meta.algorithm)) throw new Error("INVALID_TRANSFER_HEADER");
    if (!Number.isSafeInteger(meta.totalBytes) || meta.totalBytes < 1 || meta.totalBytes > MAX_PAYLOAD_BYTES ||
        !Number.isSafeInteger(meta.totalChunks) || meta.totalChunks < 1 || meta.totalChunks > MAX_CHUNKS ||
        meta.totalChunks !== Math.ceil(meta.totalBytes / CHUNK_SIZE)) throw new Error("TRANSFER_BOUNDS");
    if (this.inboundBuffers.has(meta.transferId) || this.seenTransferIds.has(meta.transferId)) throw new Error("TRANSFER_REPLAY");
    if (this.inboundBuffers.size >= MAX_INBOUND_TRANSFERS) throw new Error("TOO_MANY_INBOUND_TRANSFERS");
    const state = {peerId, meta, chunks:new Array(meta.totalChunks).fill(null), receivedChunks:0, receivedBytes:0, timer:null};
    this.inboundBuffers.set(meta.transferId, state);
    this.seenTransferIds.set(meta.transferId, Date.now());
    if (this.seenTransferIds.size > 4096) this.seenTransferIds.delete(this.seenTransferIds.keys().next().value);
    this.refreshTtl(meta.transferId, state);
  }

  refreshTtl(id, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.dropTransfer(id);
      this.log("MESH_SYNC_TRANSFER_TIMEOUT", {peerId:state.peerId, transferId:id});
    }, TRANSFER_TTL_MS);
  }

  dropTransfer(id) {
    const state = this.inboundBuffers.get(id);
    if (!state) return;
    clearTimeout(state.timer);
    this.inboundBuffers.delete(id);
  }

  async finishTransfer(peerId, msg) {
    const state = this.inboundBuffers.get(msg.transferId);
    if (!state || state.peerId !== peerId) throw new Error("UNKNOWN_TRANSFER_OR_WRONG_PEER");
    this.dropTransfer(msg.transferId);
    const meta = state.meta;
    if (state.receivedChunks !== meta.totalChunks || state.receivedBytes !== meta.totalBytes ||
        state.chunks.some(chunk => chunk === null) || typeof msg.expectedHash !== "string" ||
        msg.expectedHash.toLowerCase() !== meta.hash.toLowerCase()) throw new Error("INCOMPLETE_OR_INCONSISTENT_TRANSFER");
    const combined = new Uint8Array(state.receivedBytes);
    let offset = 0;
    for (const chunk of state.chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    const code = new TextDecoder("utf-8", {fatal:true}).decode(combined);
    const hashFn = this.engine.sha256 || this.engine.computeSHA256;
    if (typeof hashFn !== "function" || (await hashFn.call(this.engine, code)).toLowerCase() !== meta.hash.toLowerCase()) {
      await this.log("MESH_SYNC_HASH_MISMATCH", {peerId, podId:meta.podId, transferId:msg.transferId});
      throw new Error("SHARD_HASH_MISMATCH");
    }
    const configuredAlgorithm = this.engine.signatureAlgorithm || "ECDSA-P256";
    if (meta.algorithm !== configuredAlgorithm) throw new Error("SIGNATURE_ALGORITHM_POLICY_MISMATCH");
    if (this.authenticateInboundShard) {
      const receipt = await this.authenticateInboundShard({
        bytes:combined, podId:meta.podId, hash:meta.hash, signatureHex:meta.shardSignature,
        codeSignature:meta.signature, algorithm:meta.algorithm
      });
      if (!receipt?.readBackVerified || !receipt?.signatureVerified || !receipt?.authorityPinMatched ||
          receipt.sha256 !== meta.hash.toLowerCase() || receipt.byteLength !== combined.byteLength) {
        throw new Error("AUTHENTICATED_SHARD_RECEIPT_INVALID");
      }
      const peer = this.peers.get(peerId);
      if (!peer || peer.channel.readyState !== "open") throw new Error("CHANNEL_CLOSED_BEFORE_AUTHENTICATED_ACK");
      peer.channel.send(JSON.stringify({type:"OVERSEER_SHARD_ACK", transferId:msg.transferId,
        receipt:{status:receipt.status,podId:receipt.podId,byteLength:receipt.byteLength,sha256:receipt.sha256,
          storagePath:receipt.storagePath,signatureVerified:receipt.signatureVerified,
          authorityPinMatched:receipt.authorityPinMatched,readBackVerified:receipt.readBackVerified,
          durability:receipt.durability,commitHash:receipt.commitHash}}));
      await this.log("MESH_AUTHENTICATED_SHARD_ACK_SENT", {peerId,podId:meta.podId,
        transferId:msg.transferId,sha256:receipt.sha256,byteLength:receipt.byteLength,readBackVerified:true});
      return receipt;
    }
    return this.engine.mutatePod(meta.podId, code, {signature:meta.signature,origin:"peer"});
  }
}
