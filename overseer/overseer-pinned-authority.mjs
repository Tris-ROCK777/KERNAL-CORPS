/**
 * KERNEL CORP. — pinned authority startup verification.
 *
 * The pin MUST be the actual 32-byte Ed25519 public key (64 hex characters),
 * compiled into the trusted application bundle or delivered out-of-band.
 * Never use a receipt hash or an example placeholder as the authority public key.
 */
const SYSTEM_TRUSTED_AUTHORITY_PUBKEY = globalThis.KERNEL_AUTHORITY_PUBKEY_HEX || "";

function decodeHex(hex) {
  if (typeof hex !== "string" || !/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error("AUTHORITY_PIN_NOT_CONFIGURED: expected a 32-byte Ed25519 public key in hex");
  }
  return new Uint8Array(hex.match(/.{2}/g).map(pair => Number.parseInt(pair,16)));
}

export async function verifyAndInitializeVault(vaultInstance, pinnedPublicKeyHex = SYSTEM_TRUSTED_AUTHORITY_PUBKEY) {
  if (!vaultInstance || typeof vaultInstance.initOrRestore !== "function" ||
      typeof vaultInstance.getPublicKeyHex !== "function") {
    throw new Error("INVALID_AUTHORITY_VAULT_INTERFACE");
  }

  const expected = pinnedPublicKeyHex.toLowerCase();
  decodeHex(expected); // fail closed if no real pin is configured
  const keyPair = await vaultInstance.initOrRestore();
  const actualValue = await vaultInstance.getPublicKeyHex();
  const actual = String(actualValue).toLowerCase();

  if (actual !== expected) {
    throw new Error("SECURITY_ALERT: RESTORED_AUTHORITY_KEY_DOES_NOT_MATCH_PIN");
  }
  return keyPair;
}

export function getConfiguredAuthorityPin() {
  return SYSTEM_TRUSTED_AUTHORITY_PUBKEY;
}
