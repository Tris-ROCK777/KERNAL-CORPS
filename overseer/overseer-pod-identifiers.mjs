/** Canonical KERNEL CORP app IDs plus persisted legacy IDs retained for compatibility. */
export const CANONICAL_POD_IDS = Object.freeze(["X-Kom’s", "Planet-K", "KashKorner", "X-Koin’s", "Kernelodie’s", "KernelVision", "X-Shield"]);
export const LEGACY_POD_IDS = Object.freeze(["PlanetApeX", "KoinKobs", "Kernelodiez", "Kernelodie", "XShield", "Apex Studio"]);
const SUPPORTED_POD_IDS = new Set([...CANONICAL_POD_IDS, ...LEGACY_POD_IDS]);
export const isSupportedPodId = podId => SUPPORTED_POD_IDS.has(podId);
