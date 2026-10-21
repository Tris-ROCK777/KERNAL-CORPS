/**
 * KERNEL CORP. — WebSocket signaling relay regression tests.
 * Uses the same "ws" transport dependency as server-signaling.mjs.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachSignalingRelay } from "./server-signaling.mjs";

const server = createServer();
const relay = attachSignalingRelay(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const url = `ws://127.0.0.1:${address.port}/kernel-signal`;

function connect(roomId, suppliedPeerId) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (predicate, timeoutMs = 1500) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("TEST_MESSAGE_TIMEOUT"));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  };
  return {
    socket, messages, waitFor,
    async join() {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "JOIN", roomId, peerId: suppliedPeerId }));
      return waitFor(message => message.type === "JOINED");
    },
    send(message) { socket.send(JSON.stringify(message)); },
    close() { if (socket.readyState === WebSocket.OPEN) socket.close(); }
  };
}

const peers = [];
try {
  // Assigned IDs must be unique and must not trust a client-supplied identity.
  const a = connect("room_alpha", "spoofed_identity");
  peers.push(a);
  const joinedA = await a.join();
  assert.equal(joinedA.roomId, "room_alpha");
  assert.match(joinedA.peerId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(joinedA.peerId, "spoofed_identity");

  const b = connect("room_alpha", "spoofed_identity");
  peers.push(b);
  const joinedB = await b.join();
  assert.notEqual(joinedB.peerId, joinedA.peerId);
  await a.waitFor(m => m.type === "PEER_JOINED" && m.peerId === joinedB.peerId);

  // The relay must overwrite a spoofed sender ID and accept READY.
  b.send({ type: "READY", roomId: "room_alpha", peerId: "forged_sender", state: "ready" });
  const relayed = await a.waitFor(m => m.type === "READY");
  assert.equal(relayed.peerId, joinedB.peerId);
  assert.equal(relayed.roomId, "room_alpha");

  // A different room must not receive this room's signaling.
  const c = connect("room_beta", "third");
  peers.push(c);
  const joinedC = await c.join();
  assert.notEqual(joinedC.peerId, joinedA.peerId);
  b.send({ type: "OFFER", roomId: "room_alpha", peerId: "forged_sender", sdp: "test" });
  await a.waitFor(m => m.type === "OFFER");
  assert.equal(c.messages.some(m => m.type === "OFFER"), false);

  // Leave notifications carry enough routing and identity context for adapters.
  b.close();
  const left = await a.waitFor(m => m.type === "PEER_LEFT" && m.peerId === joinedB.peerId);
  assert.equal(left.roomId, "room_alpha");

  // Unknown protocol types are rejected, not relayed.
  a.send({ type: "ADMIN", roomId: "room_alpha" });
  const error = await a.waitFor(m => m.type === "ERROR" && m.message === "UNSUPPORTED_SIGNAL_TYPE");
  assert.equal(error.message, "UNSUPPORTED_SIGNAL_TYPE");

  console.log("SIGNALING_RELAY_TESTS: ALL_INVARIANTS_PASSED");
} finally {
  for (const peer of peers) peer.close();
  await new Promise(resolve => relay.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
