/**
 * KERNEL CORP. — pin-bound authority bootstrap.
 * Existing OPFS identity migrates to IndexedDB as a non-exportable Ed25519 CryptoKey.
 * No new trust root is generated during normal startup.
 */
import { OverseerKeyVault } from "./overseer-key-vault.mjs";
import { NonExportableAuthorityVault } from "./overseer-non-exportable-authority-vault.mjs";
import { verifyAndInitializeVault } from "./overseer-pinned-authority.mjs";

const PIN_FORMAT = /^[a-f0-9]{64}$/i;
const DEFAULT_PIN = "dc66faf0e8cf6de4a1cce5872c146b7e1ec5f92b184c791a47219c71da038333";

async function readLegacyVaultRecord(expectedPin) {
  if (!globalThis.navigator?.storage?.getDirectory) throw new Error("OPFS_UNAVAILABLE");
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("kernel_vault");
  const file = await dir.getFileHandle("authority.vault.json");
  const record = JSON.parse(await (await file.getFile()).text());
  if (record?.schema !== 1 || record?.algorithm !== "Ed25519" ||
      typeof record.privateJwk !== "object" ||
      String(record.publicKeyHex || "").toLowerCase() !== expectedPin) {
    throw new Error("LEGACY_AUTHORITY_RECORD_INVALID_OR_PIN_MISMATCH");
  }
  return record;
}

export async function provisionAuthorityIdentity({vaultOptions = {}, allowFirstBootProvisioning = false} = {}) {
  if (allowFirstBootProvisioning !== true) throw new Error("EXPLICIT_FIRST_BOOT_PROVISIONING_REQUIRED");
  const vault = new NonExportableAuthorityVault(vaultOptions);
  await vault.initOrRestore({allowFirstBootProvisioning:true});
  return Object.freeze({vault, publicKeyHex:vault.getPublicKeyHex(),
    status:vault.getStatus().restored ? "EXISTING_IDENTITY_LOADED_FOR_PINNING" : "NEW_IDENTITY_CREATED_REQUIRES_TRUSTED_PIN"});
}

export async function initializeTrustedAuthority({
  publicKeyHex = globalThis.KERNEL_AUTHORITY_PUBKEY_HEX || DEFAULT_PIN,
  vaultOptions = {}
} = {}) {
  if (typeof publicKeyHex !== "string" || !PIN_FORMAT.test(publicKeyHex)) {
    throw new Error("AUTHORITY_PIN_NOT_CONFIGURED: trusted 32-byte Ed25519 public key required");
  }
  const pin = publicKeyHex.toLowerCase();
  const vault = new NonExportableAuthorityVault({...vaultOptions, expectedPublicKeyHex:pin});
  try {
    await vault.initOrRestore();
  } catch (error) {
    if (error?.message !== "PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT") throw error;
    // Migrate only the already-enrolled identity from its existing OPFS record.
    // The vault migration validates the pin and keypair, then persists a
    // non-exportable CryptoKey. No replacement key is generated.
    const legacyRecord = await readLegacyVaultRecord(pin);
    await vault.migrateExistingIdentity(legacyRecord);
  }
  await verifyAndInitializeVault(vault, pin);
  if (vault.getStatus().privateKeyExtractable !== false) {
    throw new Error("AUTHORITY_PRIVATE_KEY_MUST_BE_NON_EXPORTABLE");
  }
  return Object.freeze({vault, publicKeyHex:vault.getPublicKeyHex(),
    restored:vault.getStatus().restored, status:"TRUSTED_NON_EXPORTABLE_AUTHORITY_INITIALIZED"});
}
