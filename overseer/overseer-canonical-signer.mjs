/**
 * KERNEL CORP. — deterministic canonical signer.
 * Uses sorted object keys and excludes every "signature" property from signed bytes.
 * This is a constrained canonical JSON profile, not a complete RFC 8785 implementation.
 */
function encode(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("CANONICAL_JSON_NONFINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("CANONICAL_JSON_UNSUPPORTED_TYPE");
  if (seen.has(value)) throw new TypeError("CANONICAL_JSON_CYCLE");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = "[" + value.map(item => {
      if (item === undefined) throw new TypeError("CANONICAL_JSON_UNDEFINED_ARRAY_ITEM");
      return encode(item, seen);
    }).join(",") + "]";
  } else {
    const keys = Object.keys(value).filter(key => key !== "signature").sort();
    const pairs = [];
    for (const key of keys) {
      if (value[key] === undefined) throw new TypeError("CANONICAL_JSON_UNDEFINED_FIELD");
      pairs.push(JSON.stringify(key) + ":" + encode(value[key], seen));
    }
    result = "{" + pairs.join(",") + "}";
  }
  seen.delete(value);
  return result;
}

export function canonicalizeJson(value) {
  return encode(value);
}

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new TypeError("INVALID_SIGNATURE_HEX");
  return new Uint8Array(hex.match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
}
function webCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error("WEBCRYPTO_UNAVAILABLE");
  return globalThis.crypto;
}

export async function signReceiptPayload(receiptBody, privateKey) {
  if (!privateKey) throw new Error("AUTHORITY_PRIVATE_KEY_REQUIRED");
  const encoded = new TextEncoder().encode(canonicalizeJson(receiptBody));
  const signature = await webCrypto().subtle.sign("Ed25519", privateKey, encoded);
  return {...receiptBody, signature:toHex(signature)};
}

export async function verifyReceiptPayload(signedReceipt, expectedPublicKey) {
  if (!signedReceipt || typeof signedReceipt !== "object" || !expectedPublicKey) return false;
  const {signature, ...bodyWithoutSig} = signedReceipt;
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    const encoded = new TextEncoder().encode(canonicalizeJson(bodyWithoutSig));
    return await webCrypto().subtle.verify("Ed25519", expectedPublicKey, fromHex(signature), encoded);
  } catch {
    return false;
  }
}
