import { chromium } from "playwright";

const role = process.env.KERNEL_PEER_ROLE;
const roomId = process.env.KERNEL_PEER_ROOM;
const pageUrl = process.env.KERNEL_PEER_URL ??
  "https://tris-rock777.github.io/KERNAL-CORPS/overseer/live-peer-verify.html";

if (!["sender", "receiver"].includes(role)) throw new Error("KERNEL_PEER_ROLE must be sender or receiver");
if (!roomId || !/^[A-Za-z0-9_-]{16,128}$/.test(roomId)) throw new Error("KERNEL_PEER_ROOM is invalid");

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errors = [];
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
    if (!passLine || !passLine.includes('"receivedBytes":98304') ||
        !passLine.includes('"expectedBytes":98304') || !passLine.includes('"totalChunks":3')) {
      throw new Error("LIVE_PEER_RECEIPT_ASSERTION_FAILED: " + (passLine ?? "PASS line missing"));
    }
    console.log(JSON.stringify({ event: "LIVE_PEER_PAYLOAD_RECEIVED_AND_SHA256_VERIFIED", bytes: 98304, chunks: 3, receipt: passLine }));
  }

  if (role === "receiver") {
    const persistenceUrl = pageUrl.replace("live-peer-verify.html", "live-peer-persistence-verify.html");
    await page.goto(persistenceUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(
      () => {
        const output = document.querySelector("#log")?.textContent || "";
        return output.includes("PERSISTENCE_RESTART_RECOVERY_PASS") ||
          output.includes("PERSISTENCE_RESTART_RECOVERY_FAIL");
      },
      undefined, { timeout: 60000 }
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
        receipt.signedShardRecovered !== true || receipt.byteLength < 1) {
      throw new Error("PERSISTENCE_RECOVERY_RECEIPT_ASSERTION_FAILED: " + (passLine ?? "PASS line missing"));
    }
    console.log(JSON.stringify({ event: "LIVE_PEER_AND_RESTART_RECOVERY_PASS", transportBytes: 98304, transportChunks: 3, persistence: receipt }));
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
  await browser.close();
}
