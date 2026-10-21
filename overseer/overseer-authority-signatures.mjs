/**
 * KERNEL CORP. — Ed25519 authority signature engine.
 *
 * Signatures authenticate canonical receipt bytes. Verification should pin an
 * expected public key from trusted configuration; never trust a key supplied
 * only by the receipt being checked.
 */
const HEX = /^[a-f0-9]+$/i;

function cryptoProvider() {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  throw new Error("WEBCRYPTO_UNAVAILABLE");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + canonicalize(value[key]))
    .join(",") + "}";
}

function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !HEX.test(hex)) {
    throw new Error("INVALID_HEX_ENCODING");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");

export class OverseerAuthoritySignatureEngine {
  constructor(options = {}) {
    this.keyPair = options.keyPair || null;
    this.expectedPublicKeyHex = options.expectedPublicKeyHex || null;
  }

  async initAuthorityKey() {
    this.keyPair = await cryptoProvider().subtle.generateKey(
      {name:"Ed25519"}, true, ["sign","verify"]
    );
    this.expectedPublicKeyHex = await this.exportPublicKeyHex();
    return this.keyPair;
  }

  async signReceipt(receiptBody) {
    if (!this.keyPair?.privateKey || !this.keyPair?.publicKey) {
      throw new Error("AUTHORITY_KEY_UNINITIALIZED");
    }
    const {signature: _oldSignature, signerPubKey: _oldKey, ...body} = receiptBody;
    const bytes = new TextEncoder().encode(canonicalize(body));
    const signature = await cryptoProvider().subtle.sign("Ed25519", this.keyPair.privateKey, bytes);
    return {...body, signerPubKey:await this.exportPublicKeyHex(), signature:toHex(signature)};
  }

  async verifyReceipt(signedReceipt, expectedPublicKeyHex = this.expectedPublicKeyHex) {
    if (!signedReceipt || typeof signedReceipt !== "object" || !expectedPublicKeyHex) return false;
    const {signature, signerPubKey, ...body} = signedReceipt;
    if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return false;
    if (typeof signerPubKey !== "string" || signerPubKey.toLowerCase() !== expectedPublicKeyHex.toLowerCase()) return false;
    try {
      const key = await this.importPublicKeyHex(expectedPublicKeyHex);
      return await cryptoProvider().subtle.verify(
        "Ed25519", key, fromHex(signature), new TextEncoder().encode(canonicalize(body))
      );
    } catch { return false; }
  }

  async exportPublicKeyHex() {
    if (!this.keyPair?.publicKey) throw new Error("AUTHORITY_KEY_UNINITIALIZED");
    return toHex(await cryptoProvider().subtle.exportKey("raw", this.keyPair.publicKey));
  }

  async importPublicKeyHex(hexKey) {
    const bytes = fromHex(hexKey);
    if (bytes.length !== 32) throw new Error("INVALID_ED25519_PUBLIC_KEY_LENGTH");
    return cryptoProvider().subtle.importKey("raw", bytes, {name:"Ed25519"}, false, ["verify"]);
  }
}
