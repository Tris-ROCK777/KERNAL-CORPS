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
      () => document.querySelector("#log")?.textContent.includes("TEST_SHARD_SENT_AS_CHUNKED_BINARY"),
      undefined, { timeout: 15000 }
    );
    console.log(JSON.stringify({ event: "LIVE_PEER_PAYLOAD_SENT", bytes: 98304, chunks: 3 }));
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
