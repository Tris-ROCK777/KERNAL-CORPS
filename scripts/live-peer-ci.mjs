import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const role = process.env.KERNEL_PEER_ROLE;
const roomId = process.env.KERNEL_PEER_ROOM;
const pageUrl = process.env.KERNEL_PEER_URL ??
  "https://tris-rock777.github.io/KERNAL-CORPS/overseer/live-peer-verify.html";

if (!["sender", "receiver"].includes(role)) throw new Error("KERNEL_PEER_ROLE must be sender or receiver");
if (!roomId || !/^[A-Za-z0-9_-]{16,128}$/.test(roomId)) throw new Error("KERNEL_PEER_ROOM is invalid");

const profileDir = await mkdtemp(join(tmpdir(), "kernel-peer-profile-"));
let browser = await chromium.launchPersistentContext(profileDir, { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let page = await browser.newPage();
const errors = [];
let receivedTransferSha256 = null;
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

try {
  console.log(JSON.stringify({ event: "LIVE_PEER_TEST_START", role, roomId, pageUrl }));
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.locator("#room").fill(roomId);
  await page.locator("#role").selectOption(role);
  await page.locator("#connect").click();

  const log = page.locator("#log");
  await page.waitForFunction(
    () => document.querySelector("#log")?.textContent.includes("WEBRTC_DATA_CHANNEL_OPEN"),
    undefined, { timeout: 180000 }
  );
  console.log(JSON.stringify({ event: "WEBRTC_DATA_CHANNEL_OPEN", role, roomId }));

  if (role === "sender") {
    await page.waitForFunction(() => !document.querySelector("#send")?.disabled, undefined, { timeout: 20000 });
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector("#log")?.textContent.includes("LIVE_PEER_RECEIPT_ACK"),
      undefined, { timeout: 60000 }
    );
    const senderLog = await log.textContent();
    const ackLine = senderLog.split("\\n").find(line => line.includes("LIVE_PEER_RECEIPT_ACK "));
    const ackJson = ackLine?.slice(ackLine.indexOf("LIVE_PEER_RECEIPT_ACK ") + "LIVE_PEER_RECEIPT_ACK ".length);
    const ack = ackJson ? JSON.parse(ackJson) : null;
    if (!ack || ack.byteLength !== 98304 || ack.totalChunks !== 3 || !/^[a-f0-9]{64}$/.test(ack.sha256 || "")) {
      throw new Error("LIVE_PEER_RECEIPT_ACK_ASSERTION_FAILED: " + (ackLine ?? "ACK line missing"));
    }
    console.log(JSON.stringify({ event: "LIVE_PEER_PAYLOAD_SENT_AND_RECEIPT_ACKNOWLEDGED", bytes: ack.byteLength, chunks: ack.totalChunks, sha256: ack.sha256 }));
  } else {
    await page.waitForFunction(
      () => document.querySelector("#log")?.textContent.includes("PASS: CHUNKED_BINARY_LENGTH_AND_SHA256_ONLY"),
      undefined, { timeout: 45000 }
    );
    const receivedLog = await log.textContent();
    const passLine = receivedLog.split("\n").find(line => line.includes("PASS: CHUNKED_BINARY_LENGTH_AND_SHA256_ONLY"));
    const receiptStart = passLine?.indexOf('{"transport":') ?? -1;
    const transferReceipt = receiptStart >= 0 ? JSON.parse(passLine.slice(receiptStart)) : null;
    if (!transferReceipt || transferReceipt.receivedBytes !== 98304 ||
        transferReceipt.expectedBytes !== 98304 || transferReceipt.totalChunks !== 3 ||
        transferReceipt.expectedSha256 !== transferReceipt.actualSha256) {
      throw new Error("LIVE_PEER_RECEIPT_ASSERTION_FAILED: " + (passLine ?? "PASS line missing"));
    }
    receivedTransferSha256 = transferReceipt.actualSha256;
    console.log(JSON.stringify({ event: "LIVE_PEER_PAYLOAD_RECEIVED_AND_SHA256_VERIFIED", bytes: 98304, chunks: 3, sha256: receivedTransferSha256, receipt: passLine }));
  }

  if (role === "receiver") {
    const persistenceUrl = pageUrl.replace("live-peer-verify.html", "live-peer-persistence-verify.html");
    await page.goto(persistenceUrl + "?phase=write&hold=1", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(
      () => document.querySelector("#log")?.textContent.includes("PERSISTENCE_WRITE_PASS"),
      undefined, { timeout: 60000 }
    );
    const writeLog = await page.locator("#log").textContent();
    if (!writeLog.includes("PERSISTENCE_WRITE_PASS")) throw new Error("PERSISTENCE_WRITE_PHASE_FAILED");
    console.log(JSON.stringify({ event: "PERSISTENCE_WRITE_PHASE_PASS_BEFORE_BROWSER_RESTART" }));

    // Close the entire Chromium browser context, then relaunch using the same profile
    // so OPFS, IndexedDB authority material, and localStorage must survive the restart.
    await browser.close();
    browser = await chromium.launchPersistentContext(profileDir, { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(persistenceUrl + "?phase=recover&hold=1", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(
      () => {
        const output = document.querySelector("#log")?.textContent || "";
        return output.includes("PERSISTENCE_RESTART_RECOVERY_PASS") || output.includes("PERSISTENCE_RESTART_RECOVERY_FAIL");
      }, undefined, { timeout: 60000 }
    );
    const persistenceLog = await page.locator("#log").textContent();
    const failureLine = persistenceLog.split("\\n").find(line => line.includes("PERSISTENCE_RESTART_RECOVERY_FAIL"));
    if (failureLine) throw new Error("PERSISTENCE_RESTART_RECOVERY_FAILED: " + failureLine);
    const passLine = persistenceLog.split("\\n").find(line => line.includes("PERSISTENCE_RESTART_RECOVERY_PASS"));
    const passJson = passLine?.slice(passLine.indexOf("PERSISTENCE_RESTART_RECOVERY_PASS ") + "PERSISTENCE_RESTART_RECOVERY_PASS ".length);
    const receipt = passJson ? JSON.parse(passJson) : null;
    if (!receipt || receipt.authorityRestored !== true || receipt.authorityPinMatched !== true ||
        receipt.privateKeyExtractable !== false || receipt.manifestSignatureVerified !== true ||
        receipt.opfsReadBackVerified !== true || receipt.ringWalCommitRecovered !== true ||
        receipt.signedShardRecovered !== true || receipt.sameTransferredPayloadRecovered !== true ||
        receipt.sourceTransportHash !== receivedTransferSha256 || receipt.sha256 !== receivedTransferSha256 ||
        receipt.byteLength !== 98304) {
      throw new Error("PERSISTENCE_RECOVERY_RECEIPT_ASSERTION_FAILED: " + (passLine ?? "PASS line missing"));
    }
    console.log(JSON.stringify({ event: "LIVE_PEER_AND_RESTART_RECOVERY_PASS", transportBytes: 98304, transportChunks: 3, persistence: receipt }));

    // Verify the deployed Overseer command center itself at a phone-sized viewport.
    const consoleUrl = pageUrl.replace("live-peer-verify.html", "index.html");
    // Use a clean, isolated browser context so the temporary persistence-test identity
    // cannot contaminate the production command-center trust-pin check.
    const smokeBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const smokeContext = await smokeBrowser.newContext({ viewport: { width: 393, height: 852 } });
    const smokePage = await smokeContext.newPage();
    const resourceFailures = [];
    const consoleErrors = [];
    smokePage.on("requestfailed", request => resourceFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    smokePage.on("response", response => {
      if (response.status() >= 400) resourceFailures.push({ url: response.url(), status: response.status() });
    });
    smokePage.on("pageerror", error => consoleErrors.push(String(error)));
    smokePage.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await smokePage.goto(consoleUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await smokePage.waitForFunction(
      () => {
        const frame = document.querySelector("#commandFrame");
        const log = frame?.contentDocument?.querySelector("#status")?.textContent || frame?.contentDocument?.querySelector("#log")?.textContent || "";
        return log.includes("PRODUCTION RUNTIME READY") || log.includes("RUNTIME NOT READY:") || log.includes("RUNTIME BLOCKED:");
      },
      undefined, { timeout: 60000 }
    );
    const runtimeLog = await smokePage.locator("#commandFrame").evaluate(frame =>
      frame.contentDocument?.querySelector("#status")?.textContent || frame.contentDocument?.querySelector("#log")?.textContent || ""
    );
    const runtimeMode = runtimeLog.includes("PRODUCTION RUNTIME READY")
      ? "READY"
      : (runtimeLog.includes("RUNTIME NOT READY: PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT") || runtimeLog.includes("RUNTIME BLOCKED: PINNED_AUTHORITY_KEY_MISSING_FROM_VAULT"))
        ? "EXPECTED_FAIL_CLOSED_WITHOUT_ENROLLED_AUTHORITY"
        : "UNEXPECTED_RUNTIME_FAILURE";
    if (runtimeMode === "UNEXPECTED_RUNTIME_FAILURE") {
      await smokeBrowser.close();
      throw new Error("DEPLOYED_COMMAND_CENTER_RUNTIME_FAILED: " + runtimeLog);
    }
    const ui = await smokePage.evaluate(() => {
      const frame = document.querySelector("#commandFrame");
      const doc = frame?.contentDocument;
      return {
        title: document.title,
        commandFramePresent: Boolean(frame),
        canvasPresent: Boolean(doc?.querySelector("#scene")),
        canvasWidth: doc?.querySelector("#scene")?.width ?? 0,
        canvasHeight: doc?.querySelector("#scene")?.height ?? 0,
        authorityStateDisplayed: Boolean(doc?.querySelector("#pin")?.textContent &&
          !/Loading/.test(doc.querySelector("#pin").textContent)),
        controls: ["dispatch", "sever", "scale", "rejoin", "livePeerTest"].map(id => ({
          id, visible: Boolean(doc?.querySelector("#" + id) &&
            doc.querySelector("#" + id).getBoundingClientRect().width > 0 &&
            doc.querySelector("#" + id).getBoundingClientRect().height > 0)
        }))
      };
    });
    if (!ui.commandFramePresent || !ui.canvasPresent || ui.canvasWidth <= 0 || ui.canvasHeight <= 0 ||
        !ui.authorityStateDisplayed || ui.controls.some(control => !control.visible)) {
      await smokeBrowser.close();
      throw new Error("DEPLOYED_COMMAND_CENTER_UI_ASSERTION_FAILED: " + JSON.stringify(ui));
    }
    if (resourceFailures.length || consoleErrors.length) {
      await smokeBrowser.close();
      throw new Error("DEPLOYED_COMMAND_CENTER_RESOURCE_OR_CONSOLE_ERRORS: " +
        JSON.stringify({ resourceFailures, consoleErrors }));
    }
    await smokeBrowser.close();
    console.log(JSON.stringify({ event: "DEPLOYED_COMMAND_CENTER_MOBILE_SMOKE_PASS", viewport: "393x852", runtimeMode, runtimeLog, ui, resourceFailures, consoleErrors }));
  }

  if (errors.some(error => /CONNECT_FAILED|FAIL:|Uncaught|TypeError|ReferenceError/.test(error))) {
    throw new Error("LIVE_PEER_BROWSER_ERROR: " + errors.join(" | "));
  }
  if (errors.length) console.log(JSON.stringify({ event: "BROWSER_CONSOLE_ERRORS", errors }));
  console.log(JSON.stringify({ event: "LIVE_PEER_TEST_PASS", role, roomId }));
} catch (error) {
  const logText = await page.locator("#log").textContent().catch(() => "(log unavailable)");
  console.error(JSON.stringify({ event: "LIVE_PEER_TEST_FAIL", role, roomId, error: String(error), log: logText, browserErrors: errors }));
  throw error;
} finally {
  await browser.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
