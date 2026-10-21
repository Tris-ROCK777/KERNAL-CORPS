/**
 * KERNEL CORP. — production authority bootstrap.
 *
 * Call initializeTrustedAuthority before enabling authority-controlled writes,
 * peer commits, or hot-swap. The pin must come from the trusted application
 * bundle / out-of-band provisioning. No implicit generated-key fallback exists.
 */
import { OverseerKeyVault } from "./overseer-key-vault.mjs";
import { verifyAndInitializeVault } from "./overseer-pinned-authority.mjs";

const PIN_FORMAT = /^[a-f0-9]{64}$/i;

/**
 * Explicit first-time provisioning only. Record the returned public key and
 * pin it in the trusted app bundle through a separately reviewed release.
 * Do not call this function as a normal startup fallback.
 */
export async function provisionAuthorityIdentity({vaultOptions = {}, allowFirstBootProvisioning = false} = {}) {
  if (allowFirstBootProvisioning !== true) {
    throw new Error("EXPLICIT_FIRST_BOOT_PROVISIONING_REQUIRED");
  }
  const vault = new OverseerKeyVault(vaultOptions);
  await vault.initOrRestore();
  return Object.freeze({
    vault,
    publicKeyHex: vault.getPublicKeyHex(),
    status: vault.getStatus().restored ? "EXISTING_IDENTITY_LOADED_FOR_PINNING" : "NEW_IDENTITY_CREATED_REQUIRES_TRUSTED_PIN"
  });
}

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
