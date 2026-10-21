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

  const senderMesh = new OverseerMeshReplicator(senderEngine, keyPair.publicKey);
  const receiverMesh = new OverseerMeshReplicator(receiverEngine, keyPair.publicKey);
  const channels = createLoopbackChannelPair();
  senderMesh.attachPeerChannel("receiver", channels.senderChannel);
  receiverMesh.attachPeerChannel("sender", channels.receiverChannel);
  return { keyPair, sign, senderEngine, receiverEngine, senderMesh, receiverMesh, ...channels };
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
      hash:badHash, signature:originalSignature, algorithm:"ECDSA-P256", totalBytes:bytes.length, totalChunks:chunks}));
    channel.send(f.senderMesh.packBinaryChunk(transferId, 0, bytes));
    channel.send(JSON.stringify({type:"OVERSEER_SHARD_EOF", transferId, expectedHash:badHash}));
    await wait(100);
    assert(f.receiverEngine.activePods.get("KashKorner").hash === previous, "TEST_3_FAILED: invalid signature changed active pod");
    assert(previous === goodHash, "TEST_3_SETUP_FAILED");
    results.push("tampered payload signature rejection + LKG preservation");
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
        hash:"a".repeat(64), signature:"00", algorithm:"ECDSA-P256",
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
      hash:"a".repeat(64), signature:"00", algorithm:"ECDSA-P256",
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
      hash:"a".repeat(64), signature:"00", algorithm:"ECDSA-P256",
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

  return {status:"ALL_INVARIANTS_PASSED", tests:results};
}
