/**
 * KERNEL CORP. — Authenticated shard acceptance (browser prototype).
 *
 * Caller MUST supply an independently pinned Ed25519 public key. Never trust a
 * public key merely because it arrived inside the same peer packet as a shard.
 * Verification happens before OPFS writes; stored bytes are read back and hashed.
 */
const toHex = bytes => Array.from(new Uint8Array(bytes),
  byte => byte.toString(16).padStart(2, "0")).join("");

const fromHex = value => {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error("INVALID_HEX_ENCODING");
  }
  return Uint8Array.from(value.match(/.{2}/g), pair => parseInt(pair, 16));
};

async function sha256(bytes, cryptoProvider) {
  return toHex(await cryptoProvider.subtle.digest("SHA-256", bytes));
}

/**
 * Signed message format is the UTF-8 bytes of:
 * KERNEL_SHARD_V1\n<lowercase-sha256>\n<byte-length>\n<podId>
 * Signature algorithm: Ed25519.
 */
export async function acceptAuthenticatedShard({
  bytes, signatureHex, publicKey, pinnedPublicKeyHex, signerPublicKeyHex,
  podId, crypto: cryptoProvider = globalThis.crypto,
  storage = globalThis.navigator?.storage
} = {}) {
  if (!cryptoProvider?.subtle) throw new Error("WEBCRYPTO_UNAVAILABLE");
  if (!storage?.getDirectory) throw new Error("OPFS_UNAVAILABLE");
  if (!(bytes instanceof Uint8Array)) throw new Error("SHARD_BYTES_MUST_BE_UINT8ARRAY");
  if (!bytes.byteLength || bytes.byteLength > 1024 * 1024) throw new Error("SHARD_SIZE_OUT_OF_RANGE");
  if (typeof podId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(podId)) {
    throw new Error("INVALID_POD_ID");
  }
  if (!publicKey || !/^[a-f0-9]{64}$/i.test(pinnedPublicKeyHex || "") ||
      !/^[a-f0-9]{64}$/i.test(signerPublicKeyHex || "")) {
    throw new Error("PINNED_AUTHORITY_KEY_REQUIRED");
  }
  if (signerPublicKeyHex.toLowerCase() !== pinnedPublicKeyHex.toLowerCase()) {
    throw new Error("AUTHORITY_PUBLIC_KEY_PIN_MISMATCH");
  }

  const digest = await sha256(bytes, cryptoProvider);
  const message = new TextEncoder().encode(
    `KERNEL_SHARD_V1\n${digest}\n${bytes.byteLength}\n${podId}`);
  const signature = fromHex(signatureHex);
  const valid = await cryptoProvider.subtle.verify("Ed25519", publicKey, signature, message);
  if (!valid) throw new Error("SHARD_SIGNATURE_INVALID");

  const root = await storage.getDirectory();
  const dir = await root.getDirectoryHandle("authenticated-shards", { create: true });
  const name = `${podId}-${digest}.shard`;
  const handle = await dir.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (error) {
    try { await writer.abort(); } catch {}
    throw error;
  }

  const readBack = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  const readBackHash = await sha256(readBack, cryptoProvider);
  if (readBack.byteLength !== bytes.byteLength || readBackHash !== digest) {
    await dir.removeEntry(name).catch(() => {});
    throw new Error("OPFS_READBACK_INTEGRITY_FAILED");
  }
  return {
    status: "AUTHENTICATED_SHARD_STORED",
    podId, byteLength: readBack.byteLength, sha256: readBackHash,
    storagePath: `authenticated-shards/${name}`,
    signatureVerified: true, authorityPinMatched: true, readBackVerified: true
  };
}
