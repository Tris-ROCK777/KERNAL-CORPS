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
    undefined, { timeout: 300000 }
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
    const ackLine = senderLog.split("\n").find(line => line.includes("LIVE_PEER_RECEIPT_ACK "));
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
    const failureLine = persistenceLog.split("\n").find(line => line.includes("PERSISTENCE_RESTART_RECOVERY_FAIL"));
    if (failureLine) throw new Error("PERSISTENCE_RESTART_RECOVERY_FAILED: " + failureLine);
    const passLine = persistenceLog.split("\n").find(line => line.includes("PERSISTENCE_RESTART_RECOVERY_PASS"));
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

    // Verify both shipped surfaces at a phone-sized viewport: the R3F application
    // root and the legacy X-KOM'Z command center that preserves operational tools.
    const smokeBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const smokeContext = await smokeBrowser.newContext({ viewport: { width: 393, height: 852 } });
    const smokePage = await smokeContext.newPage();
    const resourceFailures = [];
    const consoleErrors = [];
    smokePage.on("requestfailed", request => resourceFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    smokePage.on("response", response => { if (response.status() >= 400) resourceFailures.push({ url: response.url(), status: response.status() }); });
    smokePage.on("pageerror", error => consoleErrors.push(String(error?.stack || error)));
    smokePage.on("console", message => { if (message.type() === "error") { const at=message.location(); consoleErrors.push(message.text()+" @ "+String(at.url||"")+":"+String(at.lineNumber||0)); } });

    const appUrl = new URL("../?ci_smoke=" + Date.now(), pageUrl).href;
    const consoleUrl = new URL("index.html?ci_smoke=" + Date.now(), pageUrl).href;
    await smokePage.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await smokePage.locator("#root").waitFor({ state: "attached", timeout: 15000 });
    await smokePage.waitForFunction(() => {
      const canvas = document.querySelector("#root canvas");
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false;
      const rect = canvas.getBoundingClientRect();
      return Math.abs(rect.width - innerWidth) < 2 &&
        Math.abs(rect.height - innerHeight) < 2 &&
        getComputedStyle(canvas).position === "absolute" &&
        Boolean(canvas.closest(".mesh-viewport")) &&
        Math.abs(canvas.closest(".mesh-viewport").getBoundingClientRect().width - innerWidth) < 2 &&
        Math.abs(canvas.closest(".mesh-viewport").getBoundingClientRect().height - innerHeight) < 2;
    }, undefined, { timeout: 30000 });
    const r3fScene = await smokePage.evaluate(() => {
      const canvas = document.querySelector("#root canvas");
      const root = document.querySelector("#root");
      return {
        title: document.title,
        rootVisible: Boolean(root && root.getBoundingClientRect().width >= innerWidth - 1 &&
          root.getBoundingClientRect().height >= innerHeight - 1),
        canvasPresent: Boolean(canvas),
        canvasWidth: canvas?.width || 0,
        canvasHeight: canvas?.height || 0,
        fullViewport: Boolean(canvas && getComputedStyle(canvas).position === "absolute" &&
          canvas.closest(".mesh-viewport") &&
          Math.abs(canvas.closest(".mesh-viewport").getBoundingClientRect().width - innerWidth) < 2 &&
          Math.abs(canvas.closest(".mesh-viewport").getBoundingClientRect().height - innerHeight) < 2),
        defaultOverlayText: (document.body.innerText || "").trim()
      };
    });
    if (!r3fScene.rootVisible || !r3fScene.canvasPresent || !r3fScene.fullViewport ||
        r3fScene.canvasWidth <= 0 || r3fScene.canvasHeight <= 0 ||
        /scene failed|webgl renderer unavailable|kernel mesh recovery/i.test(r3fScene.defaultOverlayText)) {
      await smokeBrowser.close();
      throw new Error("R3F_MOBILE_SCENE_ASSERTION_FAILED: " + JSON.stringify(r3fScene));
    }
    console.log(JSON.stringify({ event: "R3F_MOBILE_SCENE_PASS", ...r3fScene }));

    await smokePage.goto(consoleUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await smokePage.locator("#neuralExperience").waitFor({ state: "visible", timeout: 15000 });
    await smokePage.waitForFunction(() => {
      const root = document.querySelector("#neuralExperience");
      return Boolean(root && root.querySelector("#threeMesh") &&
        root.querySelector("#ledgerDrawer") && root.querySelector("#podsDrawer") &&
        root.querySelector("#nodeTelemetry"));
    }, undefined, { timeout: 30000 });
    const neuralUi = await smokePage.evaluate(() => {
      const root = document.querySelector("#neuralExperience");
      const canvas = root?.querySelector("#threeMesh");
      const pods = [...(root?.querySelectorAll("#podsDrawer .pod-card") || [])].map(card =>
        card.querySelector(".pod-name")?.textContent?.trim() || "");
      const frame = root?.querySelector("#telemetryConsole");
      return {
        present: Boolean(root),
        visible: Boolean(root && getComputedStyle(root).display !== "none" && root.getBoundingClientRect().width > 0),
        webglCanvas: Boolean(canvas),
        canvasWidth: canvas?.width || 0,
        canvasHeight: canvas?.height || 0,
        ledgerDrawer: Boolean(root?.querySelector("#ledgerDrawer a[href*='verify']")),
        podsDrawer: Boolean(root?.querySelector("#podsDrawer .pod-card")),
        pods,
        sixPods: pods.length,
        peerTelemetry: Boolean(root?.querySelector("#nodeTelemetry")),
        preservedConsoleFrame: Boolean(frame),
        consoleFrameSrc: frame?.getAttribute("src") || ""
      };
    });
    const expectedPods = ["Planet-K", "KashKorner", "X-Koin’s", "Kernelodie’s", "KernelVision", "X-Shield"];
    if (!neuralUi.present || !neuralUi.visible || !neuralUi.webglCanvas ||
        neuralUi.canvasWidth <= 0 || neuralUi.canvasHeight <= 0 ||
        !neuralUi.ledgerDrawer || !neuralUi.podsDrawer ||
        JSON.stringify(neuralUi.pods) !== JSON.stringify(expectedPods) ||
        !neuralUi.peerTelemetry || !neuralUi.preservedConsoleFrame) {
      await smokeBrowser.close();
      throw new Error("NEURAL_OVERSEER_UI_ASSERTION_FAILED: " + JSON.stringify(neuralUi));
    }
    console.log(JSON.stringify({ event: "NEURAL_OVERSEER_MOBILE_UI_PASS", ...neuralUi }));

    // Wait for the real embedded console element and its actual readiness marker.
    // The shipped DOM uses #telemetryConsole and #log; #commandFrame/#status never existed
    // on this route, which caused the old smoke test to time out before checking anything.
    const consoleFrame = smokePage.frameLocator("#telemetryConsole");
    await consoleFrame.locator("#scene").waitFor({ state: "attached", timeout: 20000 });
    await smokePage.waitForFunction(() => {
      const frame = document.querySelector("#telemetryConsole");
      const doc = frame?.contentDocument;
      const log = doc?.querySelector("#log")?.textContent || "";
      return Boolean(doc && doc.readyState === "complete" &&
        log.trim().length > 0 && !log.includes("BOOTING LOCAL CONSOLE…"));
    }, undefined, { timeout: 30000 }).catch(async error => {
      const state = await smokePage.locator("#telemetryConsole").evaluate(frame => {
        const doc = frame.contentDocument;
        return { title: doc?.title, readyState: doc?.readyState,
          log: doc?.querySelector("#log")?.textContent || "",
          scene: Boolean(doc?.querySelector("#scene")),
          bodyText: doc?.body?.innerText?.slice(0, 1200) || "" };
      });
      throw new Error("COMMAND_CENTER_RUNTIME_DID_NOT_SETTLE: " + JSON.stringify(state) + " | " + String(error));
    });
    const runtimeState = await smokePage.locator("#telemetryConsole").evaluate(frame => {
      const doc = frame.contentDocument;
      const log = doc?.querySelector("#log")?.textContent || "";
      return {
        title: doc?.title || "",
        log,
        scene: Boolean(doc?.querySelector("#scene")),
        canvasWidth: doc?.querySelector("#scene")?.width || 0,
        canvasHeight: doc?.querySelector("#scene")?.height || 0,
        controls: ["dispatch", "sever", "scale", "rejoin", "livePeerTest"].map(id => ({
          id, present: Boolean(doc?.querySelector("#" + id)),
          visible: Boolean(doc?.querySelector("#" + id)?.getBoundingClientRect().width > 0)
        }))
      };
    });
    if (!runtimeState.scene || runtimeState.canvasWidth <= 0 || runtimeState.canvasHeight <= 0 ||
        runtimeState.controls.some(control => !control.present || !control.visible)) {
      await smokeBrowser.close();
      throw new Error("EMBEDDED_COMMAND_CONSOLE_ASSERTION_FAILED: " + JSON.stringify(runtimeState));
    }
    console.log(JSON.stringify({ event: "EMBEDDED_COMMAND_CONSOLE_SETTLED_PASS", runtimeState }));

    if (resourceFailures.length || consoleErrors.length) {
      await smokeBrowser.close();
      throw new Error("DEPLOYED_COMMAND_CENTER_RESOURCE_OR_CONSOLE_ERRORS: " +
        JSON.stringify({ resourceFailures, consoleErrors }));
    }
    await smokeBrowser.close();
    console.log(JSON.stringify({ event: "DEPLOYED_COMMAND_CENTER_MOBILE_SMOKE_PASS", viewport: "393x852", r3fScene, neuralUi, runtimeState, resourceFailures, consoleErrors }));
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
