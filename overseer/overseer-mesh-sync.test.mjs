/**
 * KERNEL CORP. — OVERSEER MESH REPLICATION & HOT-SWAP E2E VERIFICATION
 *
 * Run in a browser secure context that supports WebCrypto, Blob module imports,
 * Worker, and the File System Access API primitives mocked below.
 *
 * Tests the actual OverseerHotSwap and OverseerMeshReplicator implementations.
 * This is a browser-oriented harness; it is not a Node-only test.
 */
import { OverseerHotSwap } from "./overseer-hotswap.mjs";
import { OverseerMeshReplicator } from "./overseer-mesh-sync.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createMockOPFS() {
  const files = new Map();
  const directories = new Map();

  function directory(path = "") {
    return {
      async getDirectoryHandle(name, options = {}) {
        const key = path ? path + "/" + name : name;
        if (!directories.has(key)) {
          if (!options.create) throw new Error("Directory not found: " + key);
          directories.set(key, directory(key));
        }
        return directories.get(key);
      },
      async getFileHandle(name, options = {}) {
        const key = path ? path + "/" + name : name;
        if (!files.has(key)) {
          if (!options.create) throw new Error("File not found: " + key);
          files.set(key, "");
        }
        return {
          async createWritable() {
            let next = "";
            return {
              async write(value) {
                next = typeof value === "string"
                  ? value
                  : value instanceof Blob
                    ? await value.text()
                    : new TextDecoder().decode(value);
              },
              async close() { files.set(key, next); },
              async abort() {}
            };
          },
          async getFile() {
            if (!files.has(key)) throw new Error("File not found: " + key);
            const value = files.get(key);
            return { async text() { return value; } };
          }
        };
      },
      async removeEntry(name) {
        const key = path ? path + "/" + name : name;
        if (!files.delete(key) && !directories.delete(key)) throw new Error("Entry not found: " + key);
      }
    };
  }
  return directory();
}

function createLoopbackChannelPair() {
  function makeChannel() {
    const listeners = new Map();
    return {
      readyState: "open",
      binaryType: "arraybuffer",
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      peer: null,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      emit(type, event = {}) {
        for (const callback of listeners.get(type) || []) callback(event);
      },
      send(data) {
        if (this.readyState !== "open") throw new Error("CHANNEL_NOT_OPEN");
        const peer = this.peer;
        queueMicrotask(() => {
          if (peer.readyState === "open") peer.emit("message", { data });
        });
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        this.emit("close");
        if (this.peer.readyState !== "closed") {
          this.peer.readyState = "closed";
          this.peer.emit("close");
        }
      }
    };
  }
  const a = makeChannel();
  const b = makeChannel();
  a.peer = b;
  b.peer = a;
  return { senderChannel: a, receiverChannel: b };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("ASSERTION_TIMEOUT");
    await wait(10);
  }
}

async function createSignedFixture() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const sign = async code => {
    const bytes = new TextEncoder().encode(code);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      bytes
    );
    return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("");
  };
  return { keyPair, sign };
}

async function createSignedTestTransfer(payloadBytes, authorityKeyPair, podId) {
  if (!(payloadBytes instanceof Uint8Array) || payloadBytes.byteLength < 1) {
    throw new Error("TEST_TRANSFER_PAYLOAD_REQUIRED");
  }
  if (!podId) throw new Error("TEST_TRANSFER_POD_REQUIRED");
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", payloadBytes);
  const hashHex = Array.from(new Uint8Array(digest),
    b => b.toString(16).padStart(2, "0")).join("");
  const manifestBody = `KERNEL_SHARD_V1\n${hashHex}\n${payloadBytes.byteLength}\n${podId}`;
  const signatureBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    authorityKeyPair.privateKey,
    encoder.encode(manifestBody)
  );
  return {
    manifest: manifestBody,
    signature: Array.from(new Uint8Array(signatureBytes),
      b => b.toString(16).padStart(2, "0")).join(""),
    hash: hashHex,
    totalBytes: payloadBytes.byteLength,
    podId,
    payload: payloadBytes
  };
}

function createEngine(publicKey) {
  const engine = new OverseerHotSwap({ publicKey, signatureAlgorithm: "ECDSA-P256" });
  engine.root = null;
  engine.runSandboxGate = async code => {
    if (!code.includes("mountPod")) throw new Error("SANDBOX_REJECTED: missing mountPod");
    return { ok: true, exports: ["mountPod"] };
  };
  return engine;
}

async function makePair() {
  const { keyPair, sign } = await createSignedFixture();
  const senderEngine = createEngine(keyPair.publicKey);
  const receiverEngine = createEngine(keyPair.publicKey);
  senderEngine.root = createMockOPFS();
  receiverEngine.root = createMockOPFS();

  // Manifest signatures are Ed25519; code signatures remain under the engine's
  // pinned ECDSA-P256 key. Production uses the same authority policy end-to-end.
  const manifestKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]
  );
  const toHex = bytes => Array.from(new Uint8Array(bytes),
    b => b.toString(16).padStart(2, "0")).join("");
  const manifestBytes = (bytes, podId, hash) =>
    new TextEncoder().encode(`KERNEL_SHARD_V1\n${hash}\n${bytes.byteLength}\n${podId}`);

  const signShardManifest = async ({bytes, podId, hash}) => {
    const signedTransfer = await createSignedTestTransfer(bytes, manifestKeys, podId);
    if (signedTransfer.hash !== hash.toLowerCase()) throw new Error("TEST_MANIFEST_HASH_MISMATCH");
    return signedTransfer.signature;
  };

  const authenticateInboundShard = async ({bytes, podId, hash, signatureHex, codeSignature, algorithm}) => {
    if (algorithm !== "ECDSA-P256") throw new Error("SIGNATURE_ALGORITHM_POLICY_MISMATCH");
    const actualHash = toHex(await crypto.subtle.digest("SHA-256", bytes));
    if (actualHash !== hash.toLowerCase()) throw new Error("SHARD_HASH_MISMATCH");
    if (!/^(?:[0-9a-f]{2})+$/i.test(signatureHex || "")) throw new Error("INVALID_MANIFEST_SIGNATURE");
    const signatureBytes = Uint8Array.from(signatureHex.match(/.{2}/g),
      pair => parseInt(pair, 16));
    const validManifest = await crypto.subtle.verify(
      "Ed25519", manifestKeys.publicKey, signatureBytes,
      manifestBytes(bytes, podId, actualHash)
    );
    if (!validManifest) throw new Error("SHARD_SIGNATURE_INVALID");

    const code = new TextDecoder("utf-8", {fatal:true}).decode(bytes);
    const committed = await receiverEngine.mutatePod(podId, code, {
      signature: codeSignature, origin: "peer"
    });
    if (committed.hash !== actualHash) throw new Error("AUTHENTICATED_SHARD_HASH_MISMATCH");
    // This receipt is backed by the receiver's mock storage + verified HOTSWAP WAL.
    const storedDir = await receiverEngine.root.getDirectoryHandle("shards");
    const storedFile = await (await storedDir.getFileHandle(actualHash + ".mjs")).getFile();
    if (await storedFile.text() !== code) throw new Error("TEST_STORAGE_READBACK_MISMATCH");
    return {
      status: "AUTHENTICATED_SHARD_STORED", podId, byteLength: bytes.byteLength,
      sha256: actualHash, storagePath: `shards/${actualHash}.mjs`,
      signatureVerified: true, authorityPinMatched: true, readBackVerified: true,
      durability: "TEST_WAL_COMMIT", commitHash: committed.hash
    };
  };

  const senderMesh = new OverseerMeshReplicator(senderEngine, keyPair.publicKey, {signShardManifest});
  const receiverMesh = new OverseerMeshReplicator(receiverEngine, keyPair.publicKey, {authenticateInboundShard});
  const channels = createLoopbackChannelPair();
  senderMesh.attachPeerChannel("receiver", channels.senderChannel);
  receiverMesh.attachPeerChannel("sender", channels.receiverChannel);
  return { keyPair, sign, signShardManifest, senderEngine, receiverEngine, senderMesh, receiverMesh, ...channels };
}

async function broadcast(mesh, engine, sign, podId, code) {
  const hash = await engine.sha256(code);
  const signature = await sign(code);
  const result = await mesh.broadcastPodMutation({
    podId, hash, codeString: code, signature, algorithm: "ECDSA-P256"
  });
  assert(result.length === 1 && result[0].status === "SENT", "Sender did not complete transfer");
  return hash;
}

export async function runOverseerMeshVerification() {
  const results = [];

  // TEST 1: Multi-chunk (>64 KiB) payload makes it through hash, signature,
  // sandbox gate, OPFS shard persistence and HOTSWAP_COMMIT WAL.
  {
    const f = await makePair();
    const code = "// " + "K".repeat(70 * 1024) + "\nexport function mountPod() { return \"KashKorner-v1-LIVE\"; }";
    const hash = await broadcast(f.senderMesh, f.senderEngine, f.sign, "KashKorner", code);
    await waitUntil(() => f.receiverEngine.activePods.has("KashKorner"));
    assert(f.receiverEngine.activePods.get("KashKorner").hash === hash, "TEST_1_FAILED: active shard hash mismatch");
    const wal = await (await f.receiverEngine.root.getFileHandle("ring-wal.jsonl")).getFile();
    assert((await wal.text()).includes('"op":"HOTSWAP_COMMIT"'), "TEST_1_FAILED: missing HOTSWAP_COMMIT WAL record");
    const shardDir = await f.receiverEngine.root.getDirectoryHandle("shards");
    const shard = await (await shardDir.getFileHandle(hash + ".mjs")).getFile();
    assert((await shard.text()) === code, "TEST_1_FAILED: OPFS shard contents mismatch");
    results.push("multi-chunk signed replication + OPFS + WAL");
  }

  // TEST 2: Concurrent broadcasts interleave on one channel but explicit transfer
  // IDs and chunk indices must keep the two payloads isolated.
  {
    const f = await makePair();
    const kv = "// " + "V".repeat(40 * 1024) + "\nexport function mountPod() { return \"KernelVision-LIVE\"; }";
    const xs = "// " + "X".repeat(40 * 1024) + "\nexport function mountPod() { return \"XShield-LIVE\"; }";
    const [kvHash, xsHash] = await Promise.all([
      f.senderEngine.sha256(kv), f.senderEngine.sha256(xs)
    ]);
    const [kvSig, xsSig] = await Promise.all([f.sign(kv), f.sign(xs)]);
    await Promise.all([
      f.senderMesh.broadcastPodMutation({podId:"KernelVision", hash:kvHash, codeString:kv, signature:kvSig, algorithm:"ECDSA-P256"}),
      f.senderMesh.broadcastPodMutation({podId:"XShield", hash:xsHash, codeString:xs, signature:xsSig, algorithm:"ECDSA-P256"})
    ]);
    await waitUntil(() => f.receiverEngine.activePods.has("KernelVision") && f.receiverEngine.activePods.has("XShield"));
    assert(f.receiverEngine.activePods.get("KernelVision").hash === kvHash, "TEST_2_FAILED: KernelVision hash mismatch");
    assert(f.receiverEngine.activePods.get("XShield").hash === xsHash, "TEST_2_FAILED: XShield hash mismatch");
    results.push("concurrent transfer isolation");
  }

  // TEST 3: Tampered code with an otherwise valid original signature must fail
  // signature verification and leave the previously active shard unchanged.
  {
    const f = await makePair();
    const good = 'export function mountPod() { return "KashKorner-good"; }';
    const goodHash = await broadcast(f.senderMesh, f.senderEngine, f.sign, "KashKorner", good);
    await waitUntil(() => f.receiverEngine.activePods.has("KashKorner"));
    const previous = f.receiverEngine.activePods.get("KashKorner").hash;

    const bad = 'export function mountPod() { return "KashKorner-tampered"; }';
    const badHash = await f.senderEngine.sha256(bad);
    const originalSignature = await f.sign(good);
    // Build a valid transfer envelope for the tampered bytes but keep the signature
    // over the original bytes. Send through the real framing/receiver path.
    const channel = f.senderChannel;
    const transferId = "abcdef123456";
    const bytes = new TextEncoder().encode(bad);
    const chunks = Math.ceil(bytes.length / (32 * 1024));
    channel.send(JSON.stringify({type:"OVERSEER_SHARD_HEADER", protocol:1, transferId, podId:"KashKorner",
      hash:badHash, signature:originalSignature, shardSignature:await f.signShardManifest({bytes, podId:"KashKorner", hash:badHash}), algorithm:"ECDSA-P256", totalBytes:bytes.length, totalChunks:chunks}));
    channel.send(f.senderMesh.packBinaryChunk(transferId, 0, bytes));
    channel.send(JSON.stringify({type:"OVERSEER_SHARD_EOF", transferId, expectedHash:badHash}));
    await wait(100);
    assert(f.receiverEngine.activePods.get("KashKorner").hash === previous, "TEST_3_FAILED: invalid signature changed active pod");
    assert(previous === goodHash, "TEST_3_SETUP_FAILED");

    // A rejected peer payload must not leave a persistent shard or commit record.
    const shardDir = await f.receiverEngine.root.getDirectoryHandle("shards");
    let tamperedShardExists = false;
    try {
      await shardDir.getFileHandle(badHash + ".mjs");
      tamperedShardExists = true;
    } catch {}
    assert(!tamperedShardExists,
      "TEST_3_FAILED: signature-invalid peer payload was persisted to OPFS");
    const wal = await (await f.receiverEngine.root.getFileHandle("ring-wal.jsonl")).getFile();
    const rows = (await wal.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert(!rows.some(row => row.op === "HOTSWAP_COMMIT" && row.hash === badHash),
      "TEST_3_FAILED: signature-invalid peer payload received a HOTSWAP_COMMIT");
    assert(rows.filter(row => row.op === "HOTSWAP_COMMIT").length === 1,
      "TEST_3_FAILED: invalid peer payload unexpectedly added a commit");

    results.push("tampered payload rejected before OPFS/WAL commit; LKG preserved");
  }

  // TEST 4: A stalled bufferedAmount must abort promptly when the channel closes.
  {
    const f = await makePair();
    f.senderChannel.bufferedAmount = 512 * 1024;
    const pending = f.senderMesh.waitForDrain(f.senderChannel).then(
      () => false,
      error => /CHANNEL_ABORTED|CHANNEL_NOT_OPEN/.test(error.message)
    );
    setTimeout(() => f.senderChannel.close(), 25);
    assert(await Promise.race([pending, wait(1000).then(() => false)]), "TEST_4_FAILED: backpressure did not abort");
    results.push("backpressure close abort");
  }

  // TEST 5: Missing authority key is rejected at construction.
  let missingKeyRejected = false;
  try { new OverseerMeshReplicator(createEngine(null), null); }
  catch (error) { missingKeyRejected = error.message === "MISSING_PINNED_ENGINE_AUTHORITY_KEY"; }
  assert(missingKeyRejected, "TEST_5_FAILED: missing authority key accepted");
  results.push("mandatory authority key");

  // TEST 6: A successful local hot-swap automatically broadcasts its signed shard.
  // The receiving peer applies it with origin="peer", so it must not echo it back.
  {
    const f = await makePair();
    const code = 'export function mountPod() { return "automatic-local-commit-broadcast"; }';
    const signature = await f.sign(code);
    const localResult = await f.senderEngine.mutatePod("KernelVision", code, {signature});
    assert(localResult.status === "HOTSWAP_LIVE", "TEST_6_FAILED: local mutation did not commit");
    const expectedHash = await f.senderEngine.sha256(code);
    await waitUntil(() => f.receiverEngine.activePods.has("KernelVision"));
    assert(f.receiverEngine.activePods.get("KernelVision").hash === expectedHash,
      "TEST_6_FAILED: local commit was not automatically replicated");
    const receiverWal = await (await f.receiverEngine.root.getFileHandle("ring-wal.jsonl")).getFile();
    assert((await receiverWal.text()).includes('"op":"HOTSWAP_COMMIT"'),
      "TEST_6_FAILED: receiver did not commit replicated shard");
    results.push("automatic broadcast after successful local hot-swap; no peer echo");
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
  }

  // TEST 7: restart recovery must reject a shard whose persisted signature was tampered with.
  {
    const { keyPair, sign } = await createSignedFixture();
    const root = createMockOPFS();
    const engine = createEngine(keyPair.publicKey);
    engine.root = root;
    const code = 'export function mountPod() { return "recovery-signature-check"; }';
    const signature = await sign(code);
    await engine.mutatePod("KernelVision", code, {signature});
    const walHandle = await root.getFileHandle("ring-wal.jsonl");
    const walFile = await walHandle.getFile();
    const rows = (await walFile.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const commit = rows.find(row => row.op === "HOTSWAP_COMMIT");
    assert(commit, "TEST_7_SETUP_FAILED: missing commit record");
    commit.signature = "00";
    const writer = await walHandle.createWritable();
    await writer.write(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await writer.close();

    const recovered = createEngine(keyPair.publicKey);
    recovered.root = root;
    await recovered.recoverFromRestart();
    assert(!recovered.activePods.has("KernelVision"),
      "TEST_7_FAILED: recovery mounted a shard with an invalid persisted signature");
    results.push("restart recovery rejects invalid persisted signature");
  }

  // TEST 8: a caller-supplied public key must never override the engine's pinned authority.
  {
    const pinned = await createSignedFixture();
    const attacker = await createSignedFixture();
    const engine = createEngine(pinned.keyPair.publicKey);
    engine.root = createMockOPFS();
    const code = 'export function mountPod() { return "untrusted-key-substitution"; }';
    const signature = await attacker.sign(code);
    let rejected = false;
    try {
      await engine.mutatePod("KernelVision", code, {
        signature,
        publicKey: attacker.keyPair.publicKey
      });
    } catch (error) {
      rejected = /AUTH_FAILED/.test(String(error?.message));
    }
    assert(rejected, "TEST_8_FAILED: caller-supplied key overrode pinned authority");
    assert(!engine.activePods.has("KernelVision"), "TEST_8_FAILED: untrusted module became active");
    results.push("caller-supplied public key cannot override pinned authority");
  }

  // TEST 9: a corrupt newest commit must fall back to the last verified commit for that pod.
  {
    const fixture = await createSignedFixture();
    const root = createMockOPFS();
    const engine = createEngine(fixture.keyPair.publicKey);
    engine.root = root;
    const good = 'export function mountPod() { return "known-good-before-corruption"; }';
    const newer = 'export function mountPod() { return "newer-commit-with-corrupt-signature"; }';
    const goodSignature = await fixture.sign(good);
    const newerSignature = await fixture.sign(newer);
    const goodResult = await engine.mutatePod("KernelVision", good, {signature:goodSignature});
    await engine.mutatePod("KernelVision", newer, {signature:newerSignature});

    const walHandle = await root.getFileHandle("ring-wal.jsonl");
    const walFile = await walHandle.getFile();
    const rows = (await walFile.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const commits = rows.filter(row => row.op === "HOTSWAP_COMMIT");
    assert(commits.length === 2, "TEST_9_SETUP_FAILED: expected two commits");
    commits[1].signature = "00";
    const writer = await walHandle.createWritable();
    await writer.write(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await writer.close();

    const recovered = createEngine(fixture.keyPair.publicKey);
    recovered.root = root;
    await recovered.recoverFromRestart();
    assert(recovered.activePods.get("KernelVision")?.hash === goodResult.hash,
      "TEST_9_FAILED: recovery did not restore last verified commit");
    results.push("recovery falls back to last verified commit after corrupt newest commit");
  }

  // TEST 10: the mesh layer must reject a different trust root from the engine.
  {
    const trusted = await createSignedFixture();
    const attacker = await createSignedFixture();
    const engine = createEngine(trusted.keyPair.publicKey);
    let rejected = false;
    try {
      new OverseerMeshReplicator(engine, attacker.keyPair.publicKey);
    } catch (error) {
      rejected = /AUTHORITY_KEY_MISMATCH/.test(String(error?.message));
    }
    assert(rejected, "TEST_10_FAILED: mesh accepted a trust root different from the engine");
    results.push("mesh rejects authority key mismatch with engine trust root");
  }

  // TEST 11: storage initialization must fail before recovery when no pinned authority exists.
  {
    const engine = createEngine(null);
    let rejected = false;
    try {
      await engine.init();
    } catch (error) {
      rejected = /PINNED_AUTHORITY_PUBLIC_KEY_REQUIRED/.test(String(error?.message));
    }
    assert(rejected, "TEST_11_FAILED: engine initialized without a pinned authority key");
    results.push("initialization fails closed without pinned authority");
  }


  // TEST 12: a near-limit payload traverses the actual framing, signature,
  // hash, OPFS persistence and WAL commit path.
  {
    const f = await makePair();
    const suffix = '\nexport function mountPod() { return "near-limit-transfer"; }';
    const code = "// " + "K".repeat(1_048_300) + suffix;
    assert(new TextEncoder().encode(code).byteLength <= 1_048_576,
      "TEST_12_SETUP_FAILED: fixture exceeds configured payload limit");
    const hash = await broadcast(f.senderMesh, f.senderEngine, f.sign, "KashKorner", code);
    await waitUntil(() => f.receiverEngine.activePods.has("KashKorner"), 10000);
    assert(f.receiverEngine.activePods.get("KashKorner").hash === hash,
      "TEST_12_FAILED: near-limit active shard hash mismatch");
    const shardDir = await f.receiverEngine.root.getDirectoryHandle("shards");
    const stored = await (await shardDir.getFileHandle(hash + ".mjs")).getFile();
    assert((await stored.text()) === code, "TEST_12_FAILED: near-limit OPFS read-back mismatch");
    results.push("near-limit multi-chunk signed transfer + persistence");
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
  }

  // TEST 13: an oversized inbound header is rejected before buffer allocation.
  {
    const f = await makePair();
    let rejected = false;
    try {
      f.receiverMesh.startTransfer("sender", {
        protocol:1, transferId:"fedcba654321", podId:"KashKorner",
        hash:"a".repeat(64), signature:"00", shardSignature:"00", algorithm:"ECDSA-P256",
        totalBytes:1_048_577, totalChunks:33
      });
    } catch (error) {
      rejected = /TRANSFER_BOUNDS/.test(String(error?.message));
    }
    assert(rejected, "TEST_13_FAILED: oversized transfer header accepted");
    assert(f.receiverMesh.inboundBuffers.size === 0,
      "TEST_13_FAILED: oversized transfer allocated inbound state");
    results.push("oversized inbound payload rejected before allocation");
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
  }


  // TEST 14: a transfer ID cannot be opened twice, even before the first
  // transfer has received any payload bytes.
  {
    const f = await makePair();
    const header = {
      protocol:1, transferId:"abcdef123456", podId:"KashKorner",
      hash:"a".repeat(64), signature:"00", shardSignature:"00", algorithm:"ECDSA-P256",
      totalBytes:32, totalChunks:1
    };
    f.receiverMesh.startTransfer("sender", header);
    let rejected = false;
    try { f.receiverMesh.startTransfer("sender", {...header}); }
    catch (error) { rejected = /TRANSFER_REPLAY/.test(String(error?.message)); }
    assert(rejected, "TEST_14_FAILED: duplicate transfer ID was accepted");
    assert(f.receiverMesh.inboundBuffers.size === 1,
      "TEST_14_FAILED: duplicate header altered the original transfer state");
    f.receiverMesh.dropTransfer(header.transferId);
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
    results.push("duplicate transfer ID rejected without replacing active transfer");
  }

  // TEST 15: EOF from a different peer must not complete or install a transfer.
  {
    const f = await makePair();
    const header = {
      protocol:1, transferId:"123456abcdef", podId:"KashKorner",
      hash:"a".repeat(64), signature:"00", shardSignature:"00", algorithm:"ECDSA-P256",
      totalBytes:32, totalChunks:1
    };
    f.receiverMesh.startTransfer("sender", header);
    let rejected = false;
    try {
      await f.receiverMesh.finishTransfer("attacker", {
        type:"OVERSEER_SHARD_EOF", transferId:header.transferId, expectedHash:header.hash
      });
    } catch (error) { rejected = /UNKNOWN_TRANSFER_OR_WRONG_PEER/.test(String(error?.message)); }
    assert(rejected, "TEST_15_FAILED: EOF from a different peer was accepted");
    assert(f.receiverMesh.inboundBuffers.has(header.transferId),
      "TEST_15_FAILED: wrong-peer EOF changed legitimate transfer state");
    assert(!f.receiverEngine.activePods.has("KashKorner"),
      "TEST_15_FAILED: wrong-peer EOF installed a shard");
    f.receiverMesh.dropTransfer(header.transferId);
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
    results.push("wrong-peer EOF rejected; legitimate transfer state preserved");
  }


  // TEST 16: a storage write failure must not replace the active last-known-good shard.
  {
    const fixture = await createSignedFixture();
    const engine = createEngine(fixture.keyPair.publicKey);
    engine.root = createMockOPFS();
    const good = 'export function mountPod() { return "preserve-this-active-version"; }';
    const goodSignature = await fixture.sign(good);
    const first = await engine.mutatePod("KashKorner", good, {signature:goodSignature});
    const beforeWal = await (await (await engine.root.getFileHandle("ring-wal.jsonl")).getFile()).text();
    const originalWrite = engine.writeVerifiedShard.bind(engine);
    engine.writeVerifiedShard = async () => { throw new Error("SIMULATED_OPFS_WRITE_FAILURE"); };
    const badAttempt = 'export function mountPod() { return "must-not-become-active"; }';
    const badSignature = await fixture.sign(badAttempt);
    let rejected = false;
    try { await engine.mutatePod("KashKorner", badAttempt, {signature:badSignature}); }
    catch (error) { rejected = /SIMULATED_OPFS_WRITE_FAILURE/.test(String(error?.message)); }
    engine.writeVerifiedShard = originalWrite;
    assert(rejected, "TEST_16_FAILED: simulated storage failure was not surfaced");
    assert(engine.activePods.get("KashKorner")?.hash === first.hash,
      "TEST_16_FAILED: failed storage write replaced active last-known-good shard");
    const afterWal = await (await (await engine.root.getFileHandle("ring-wal.jsonl")).getFile()).text();
    const commits = afterWal.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.op === "HOTSWAP_COMMIT");
    assert(commits.length === 1 && afterWal.includes("HOTSWAP_MOUNT_FAILED"),
      "TEST_16_FAILED: failed write unexpectedly committed or was not recorded");
    assert(beforeWal.includes(first.hash), "TEST_16_SETUP_FAILED: initial commit not recorded");
    results.push("storage write failure preserves active LKG and records no new commit");
  }

  // TEST 17: rollback retrieves the prior signed commit from newline-delimited WAL
  // without requiring a caller-supplied signature.
  {
    const fixture = await createSignedFixture();
    const engine = createEngine(fixture.keyPair.publicKey);
    engine.root = createMockOPFS();
    const knownGood = 'export function mountPod() { return "rollback-known-good"; }';
    const newer = 'export function mountPod() { return "rollback-newer-version"; }';
    const goodSignature = await fixture.sign(knownGood);
    const newerSignature = await fixture.sign(newer);
    const first = await engine.mutatePod("KashKorner", knownGood, {signature:goodSignature});
    await engine.mutatePod("KashKorner", newer, {signature:newerSignature});
    const rolledBack = await engine.rollbackPod("KashKorner");
    assert(rolledBack.hash === first.hash,
      "TEST_17_FAILED: rollback did not restore the prior signed shard");
    assert(engine.activePods.get("KashKorner")?.hash === first.hash,
      "TEST_17_FAILED: rollback target did not become active");
    results.push("rollback resolves prior signature from newline-delimited WAL");
  }

  // TEST 18: concurrent WAL appends are serialized and no record is lost.
  {
    const fixture = await createSignedFixture();
    const engine = createEngine(fixture.keyPair.publicKey);
    engine.root = createMockOPFS();
    await Promise.all(Array.from({length:24}, (_, index) =>
      engine.appendRingWAL({op:"CONCURRENT_APPEND_TEST", index})
    ));
    const wal = await (await engine.root.getFileHandle("ring-wal.jsonl")).getFile();
    const rows = (await wal.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const recorded = rows.filter(row => row.op === "CONCURRENT_APPEND_TEST").map(row => row.index).sort((a,b) => a-b);
    assert(recorded.length === 24 && recorded.every((value, index) => value === index),
      "TEST_18_FAILED: concurrent WAL append lost or duplicated records");
    results.push("concurrent WAL append serialization preserves every record");
  }

  // TEST 19: a corrupt newer WAL line must not block authenticated LKG rollback.
  {
    const fixture = await createSignedFixture();
    const root = createMockOPFS();
    const engine = createEngine(fixture.keyPair.publicKey);
    engine.root = root;
    const knownGood = 'export function mountPod() { return "rollback-after-torn-wal"; }';
    const newer = 'export function mountPod() { return "rollback-newer-with-torn-wal"; }';
    const goodSignature = await fixture.sign(knownGood);
    const newerSignature = await fixture.sign(newer);
    const first = await engine.mutatePod("KashKorner", knownGood, {signature:goodSignature});
    await engine.mutatePod("KashKorner", newer, {signature:newerSignature});
    const walHandle = await root.getFileHandle("ring-wal.jsonl");
    const walText = await (await walHandle.getFile()).text();
    const writer = await walHandle.createWritable();
    await writer.write(walText + '{"op":"TORN_CORRUPT_ROW"\n');
    await writer.close();
    const rolledBack = await engine.rollbackPod("KashKorner");
    assert(rolledBack.hash === first.hash,
      "TEST_19_FAILED: corrupt trailing WAL row blocked rollback to signed LKG");
    assert(engine.activePods.get("KashKorner")?.hash === first.hash,
      "TEST_19_FAILED: authenticated LKG was not restored after corrupt WAL row");
    results.push("rollback skips corrupt WAL rows and restores signed LKG");
  }


  // TEST 20: incomplete EOF must preserve the active last-known-good shard.
  {
    const f = await makePair();
    const good = 'export function mountPod() { return "incomplete-transfer-keeps-LKG"; }';
    const goodHash = await broadcast(f.senderMesh, f.senderEngine, f.sign, "KashKorner", good);
    await waitUntil(() => f.receiverEngine.activePods.has("KashKorner"));
    const transferId = "c0ffee123456";
    f.receiverMesh.startTransfer("sender", {
      protocol:1, transferId, podId:"KashKorner", hash:"a".repeat(64),
      signature:"00", shardSignature:"00", algorithm:"ECDSA-P256", totalBytes:32, totalChunks:1
    });
    let rejected = false;
    try {
      await f.receiverMesh.finishTransfer("sender", {
        type:"OVERSEER_SHARD_EOF", transferId, expectedHash:"a".repeat(64)
      });
    } catch (error) {
      rejected = /INCOMPLETE_OR_INCONSISTENT_TRANSFER/.test(String(error?.message));
    }
    assert(rejected, "TEST_20_FAILED: incomplete transfer was accepted at EOF");
    assert(f.receiverEngine.activePods.get("KashKorner")?.hash === goodHash,
      "TEST_20_FAILED: incomplete transfer replaced active last-known-good shard");
    assert(!f.receiverMesh.inboundBuffers.has(transferId),
      "TEST_20_FAILED: rejected incomplete transfer state was not cleared");
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
    results.push("incomplete EOF rejected; active last-known-good shard preserved");
  }

  // TEST 21: duplicate chunk indices must abort the transfer rather than overwrite bytes.
  {
    const f = await makePair();
    const transferId = "d00d12345678";
    f.receiverMesh.startTransfer("sender", {
      protocol:1, transferId, podId:"KashKorner", hash:"b".repeat(64),
      signature:"00", shardSignature:"00", algorithm:"ECDSA-P256", totalBytes:32, totalChunks:1
    });
    const frame = f.senderMesh.packBinaryChunk(transferId, 0, new Uint8Array(32).fill(7));
    await f.receiverMesh.handleInboundFrame("sender", frame);
    let rejected = false;
    try { await f.receiverMesh.handleInboundFrame("sender", frame); }
    catch (error) { rejected = /CHUNK_BOUNDS_OR_DUPLICATE/.test(String(error?.message)); }
    assert(rejected, "TEST_21_FAILED: duplicate chunk index was accepted");
    assert(!f.receiverMesh.inboundBuffers.has(transferId),
      "TEST_21_FAILED: duplicate chunk did not clear rejected transfer state");
    assert(!f.receiverEngine.activePods.has("KashKorner"),
      "TEST_21_FAILED: duplicate chunk caused a shard to become active");
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
    results.push("duplicate chunk rejected and transfer state discarded");
  }

  // TEST 22: a peer-received shard is durably stored and survives engine restart.
  {
    const f = await makePair();
    const code = 'export function mountPod() { return "peer-shard-survives-restart"; }';
    const hash = await broadcast(f.senderMesh, f.senderEngine, f.sign, "KashKorner", code);
    await waitUntil(() => f.receiverEngine.activePods.get("KashKorner")?.hash === hash);

    const receiverRoot = f.receiverEngine.root;
    const walFile = await (await receiverRoot.getFileHandle("ring-wal.jsonl")).getFile();
    const walRows = (await walFile.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert(walRows.some(row => row.op === "HOTSWAP_COMMIT" && row.hash === hash),
      "TEST_22_FAILED: peer-received shard was not committed to the receiver WAL");

    const shardDir = await receiverRoot.getDirectoryHandle("shards");
    const stored = await (await shardDir.getFileHandle(hash + ".mjs")).getFile();
    assert(await stored.text() === code,
      "TEST_22_FAILED: peer-received shard did not persist byte-for-byte");

    const recovered = createEngine(f.keyPair.publicKey);
    recovered.root = receiverRoot;
    await recovered.recoverFromRestart();
    assert(recovered.activePods.get("KashKorner")?.hash === hash,
      "TEST_22_FAILED: restart recovery did not restore peer-received shard");
    f.senderMesh.dispose();
    f.receiverMesh.dispose();
    results.push("peer-received shard persists to OPFS/WAL and survives restart recovery");
  }

  // TEST 23: a WAL commit failure must preserve the active last-known-good shard.
  {
    const fixture = await createSignedFixture();
    const root = createMockOPFS();
    const engine = createEngine(fixture.keyPair.publicKey);
    engine.root = root;
    const good = 'export function mountPod() { return "preserve-active-on-wal-failure"; }';
    const goodResult = await engine.mutatePod("KashKorner", good, {signature:await fixture.sign(good)});
    const originalAppend = engine.appendRingWAL.bind(engine);
    engine.appendRingWAL = async entry => {
      if (entry.op === "HOTSWAP_COMMIT" && entry.hash !== goodResult.hash) {
        throw new Error("SIMULATED_WAL_COMMIT_FAILURE");
      }
      return originalAppend(entry);
    };

    const candidate = 'export function mountPod() { return "must-not-activate-without-wal"; }';
    let rejected = false;
    try {
      await engine.mutatePod("KashKorner", candidate, {signature:await fixture.sign(candidate)});
    } catch (error) {
      rejected = /SIMULATED_WAL_COMMIT_FAILURE/.test(String(error?.message));
    }
    engine.appendRingWAL = originalAppend;
    assert(rejected, "TEST_23_FAILED: failed WAL commit was not surfaced");
    assert(engine.activePods.get("KashKorner")?.hash === goodResult.hash,
      "TEST_23_FAILED: candidate became active before its WAL commit succeeded");

    const wal = await (await root.getFileHandle("ring-wal.jsonl")).getFile();
    const rows = (await wal.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert(rows.filter(row => row.op === "HOTSWAP_COMMIT").length === 1,
      "TEST_23_FAILED: failed candidate was recorded as a committed shard");
    assert(rows.some(row => row.op === "HOTSWAP_MOUNT_FAILED" && /SIMULATED_WAL_COMMIT_FAILURE/.test(row.reason)),
      "TEST_23_FAILED: WAL commit failure was not recorded");

    const recovered = createEngine(fixture.keyPair.publicKey);
    recovered.root = root;
    await recovered.recoverFromRestart();
    assert(recovered.activePods.get("KashKorner")?.hash === goodResult.hash,
      "TEST_23_FAILED: restart recovery did not restore last-known-good shard after WAL failure");
    results.push("WAL commit failure preserves active LKG and restart recovery");
  }

  // TEST 24: canonical seven-app IDs replicate; persisted legacy identifiers remain accepted.
  {
    const canonicalApps = ["X-Kom’s", "Planet-K", "KashKorner", "X-Koin’s", "Kernelodie’s", "KernelVision", "X-Shield"];
    const legacyApps = ["PlanetApeX", "KoinKobs", "Kernelodiez", "Kernelodie", "XShield", "Apex Studio"];
    const f = await makePair();
    for (const podId of canonicalApps) {
      const code = 'export function mountPod() { return ' + JSON.stringify("canonical:" + podId) + '; }';
      const hash = await broadcast(f.senderMesh, f.senderEngine, f.sign, podId, code);
      await waitUntil(() => f.receiverEngine.activePods.get(podId)?.hash === hash);
      assert(f.receiverEngine.activePods.get(podId)?.hash === hash, "TEST_24_FAILED: canonical pod not replicated: " + podId);
    }
    for (const podId of legacyApps) {
      const code = 'export function mountPod() { return ' + JSON.stringify("legacy:" + podId) + '; }';
      const result = await f.senderEngine.mutatePod(podId, code, {signature:await f.sign(code)});
      assert(result.podId === podId, "TEST_24_FAILED: legacy pod ID rejected: " + podId);
    }
    let invalidRejected = false;
    try {
      await f.senderMesh.broadcastPodMutation({podId:"NotAKernelApp", hash:"a".repeat(64),
        codeString:"export function mountPod() {}", signature:"00", shardSignature:"00", algorithm:"ECDSA-P256"});
    } catch (error) { invalidRejected = /INVALID_POD/.test(String(error?.message)); }
    assert(invalidRejected, "TEST_24_FAILED: unsupported pod ID was not rejected");
    f.senderMesh.dispose(); f.receiverMesh.dispose();
    results.push("all seven canonical app IDs replicate; legacy IDs remain accepted; unknown IDs rejected");
  }

  return {status:"ALL_INVARIANTS_PASSED", tests:results};
}
