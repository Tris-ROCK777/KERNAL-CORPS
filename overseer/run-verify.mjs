/**
 * KERNEL CORP. — Node 20+ CI entrypoint for the Overseer E2E harness.
 * Zero npm dependencies. OPFS and RTCDataChannel are deterministic in-memory
 * test doubles in the harness; this is not a real-browser/device integration test.
 */
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const NativeBlob = globalThis.Blob;
globalThis.Blob = class KernelBlob extends NativeBlob {
  constructor(parts = [], options = {}) {
    super(parts, options);
    this.__text = parts.map(part => typeof part === "string" ? part : String(part)).join("");
  }
};

// Node cannot import blob: URLs in the same way browsers do. Map Blob URLs to
// standard JavaScript data URLs, which Node's ESM loader supports.
const revoked = new Set();
URL.createObjectURL = blob => {
  const source = typeof blob.__text === "string" ? blob.__text : "";
  return "data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64");
};
URL.revokeObjectURL = url => { revoked.add(url); };

// Minimal Worker compatibility shim for the hot-swap module's smoke-test gate.
// The current E2E harness overrides runSandboxGate with a deterministic check;
// this shim is available if a test exercises the Worker contract directly.
globalThis.Worker = class KernelWorkerShim {
  constructor(_url, _options = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }
  postMessage(code) {
    queueMicrotask(async () => {
      if (this.terminated) return;
      try {
        const source = "data:text/javascript;base64," +
          Buffer.from(String(code), "utf8").toString("base64");
        const module = await import(source);
        const exports = Object.keys(module);
        if (typeof module.mountPod !== "function" && typeof module.default !== "function") {
          throw new Error("Missing mountPod() or default() export");
        }
        this.onmessage?.({ data: { ok: true, exports } });
      } catch (error) {
        this.onmessage?.({ data: { ok: false, error: String(error?.message || error) } });
      }
    });
  }
  terminate() { this.terminated = true; }
};

const { runOverseerMeshVerification } = await import("./overseer-mesh-sync.test.mjs");
const receipt = await runOverseerMeshVerification();
console.log("OVERSEER_VERIFY_RECEIPT:", JSON.stringify(receipt, null, 2));
if (receipt?.status !== "ALL_INVARIANTS_PASSED") process.exitCode = 1;
