/**
 * KERNEL CORP. — production authority bootstrap.
 *
 * Call this before enabling authority-controlled writes, peer commits, or hot-swap.
 * The pin must come from the trusted application bundle / out-of-band provisioning.
 * This module deliberately has no generated-key fallback.
 */
import { OverseerKeyVault } from "./overseer-key-vault.mjs";
import { verifyAndInitializeVault } from "./overseer-pinned-authority.mjs";

const PIN_FORMAT = /^[a-f0-9]{64}$/i;

export async function initializeTrustedAuthority({
  publicKeyHex = globalThis.KERNEL_AUTHORITY_PUBKEY_HEX || "",
  vaultOptions = {}
} = {}) {
  if (typeof publicKeyHex !== "string" || !PIN_FORMAT.test(publicKeyHex)) {
    throw new Error("AUTHORITY_PIN_NOT_CONFIGURED: trusted 32-byte Ed25519 public key required");
  }

  const normalizedPin = publicKeyHex.toLowerCase();
  const vault = new OverseerKeyVault({
    ...vaultOptions,
    expectedPublicKeyHex: normalizedPin
  });
  await verifyAndInitializeVault(vault, normalizedPin);

  return Object.freeze({
    vault,
    publicKeyHex: vault.getPublicKeyHex(),
    restored: vault.getStatus().restored,
    status: "TRUSTED_AUTHORITY_INITIALIZED"
  });
}
