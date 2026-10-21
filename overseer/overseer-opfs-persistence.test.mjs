import { OverseerHotSwap } from "./overseer-hotswap.mjs";

const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");

export async function runRealOPFSPersistenceVerification() {
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || !crypto?.subtle) {
    throw new Error("REAL_OPFS_UNAVAILABLE: use a secure browser context with OPFS and WebCrypto");
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const code = 'export function mountPod() { return "real-opfs-restart-recovery"; }';
  const signature = hex(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(code)
  ));
  const originRoot = await navigator.storage.getDirectory();
  const tempName = "__kernel_opfs_verify_" + crypto.randomUUID();
  let root;
  let engine;
  let recovered;

  try {
    root = await originRoot.getDirectoryHandle(tempName, { create: true });
    engine = new OverseerHotSwap({ publicKey: keyPair.publicKey, signatureAlgorithm: "ECDSA-P256" });
    engine.root = root;

    const commit = await engine.mutatePod("KashKorner", code, { signature });
    if (commit.status !== "HOTSWAP_LIVE") throw new Error("REAL_OPFS_COMMIT_FAILED");

    const shardDir = await root.getDirectoryHandle("shards");
    const storedCode = await (await (await shardDir.getFileHandle(commit.hash + ".mjs")).getFile()).text();
    if (storedCode !== code) throw new Error("REAL_OPFS_READBACK_MISMATCH");

    const walText = await (await (await root.getFileHandle("ring-wal.jsonl")).getFile()).text();
    const walRows = walText.split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (!walRows.some(row => row.op === "HOTSWAP_COMMIT" && row.hash === commit.hash)) {
      throw new Error("REAL_OPFS_WAL_COMMIT_MISSING");
    }

    recovered = new OverseerHotSwap({ publicKey: keyPair.publicKey, signatureAlgorithm: "ECDSA-P256" });
    recovered.root = root;
    await recovered.recoverFromRestart();
    const restored = recovered.activePods.get("KashKorner");
    if (restored?.hash !== commit.hash) throw new Error("REAL_OPFS_RESTART_RECOVERY_FAILED");
    if (restored.module.mountPod() !== "real-opfs-restart-recovery") {
      throw new Error("REAL_OPFS_RESTORED_MODULE_OUTPUT_MISMATCH");
    }

    return {
      status: "REAL_OPFS_RESTART_RECOVERY_PASSED",
      checks: [
        "signed shard written to browser OPFS",
        "shard read-back matched exact source",
        "WAL commit persisted in OPFS",
        "fresh engine restored and verified the shard after restart"
      ],
      hash: commit.hash
    };
  } finally {
    for (const instance of [engine, recovered]) {
      if (!instance) continue;
      for (const pod of instance.activePods.values()) {
        if (pod.objectUrl) URL.revokeObjectURL(pod.objectUrl);
      }
    }
    try { await originRoot.removeEntry(tempName, { recursive: true }); } catch {}
  }
}
