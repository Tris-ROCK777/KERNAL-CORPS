/**
 * KERNEL CORP. — ROOM-BASED WEBSOCKET SIGNALING RELAY
 *
 * Attach to an existing Node HTTP/Express server:
 *   import { attachSignalingRelay } from "./server-signaling.mjs";
 *   attachSignalingRelay(server);
 *
 * WebSocket path: /kernel-signal
 * Protocol: { type: "JOIN", roomId, peerId? }, then OFFER / ANSWER / ICE messages.
 *
 * Security: room IDs are routing tokens, NOT authentication. This relay
 * generates an opaque per-connection sender ID and overwrites any client
 * supplied peerId before forwarding signaling. It does not authenticate
 * who the connection belongs to; use an authenticated HTTP upgrade hook or
 * an application-level signed handshake for that.
 *
 * This relays signaling only. It never receives shard payloads or private keys.
 */
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const MAX_ROOM_ID_LENGTH = 96;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_CLIENTS_PER_ROOM = 8;
const SIGNAL_TYPES = new Set(["READY", "OFFER", "ANSWER", "ICE"]);

function validToken(value, maxLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 1024 * 1024) {
    ws.close(1013, "signaling backpressure");
    return;
  }
  ws.send(JSON.stringify(payload));
}

export function attachSignalingRelay(server, { path = "/kernel-signal" } = {}) {
  if (!server || typeof server.on !== "function") {
    throw new Error("HTTP_SERVER_REQUIRED");
  }

  const wss = new WebSocketServer({
    server,
    path,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false
  });
  const rooms = new Map();
  const membership = new Map();
  const connectionIds = new Map();

  function leave(ws) {
    const roomId = membership.get(ws);
    const peerId = connectionIds.get(ws);
    membership.delete(ws);
    connectionIds.delete(ws);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(ws);
    for (const peer of room) safeSend(peer, { type: "PEER_LEFT", roomId, peerId });
    if (room.size === 0) rooms.delete(roomId);
  }

  wss.on("connection", ws => {
    let joined = false;
    // Never trust a sender identity supplied in a signaling payload.
    const senderId = randomUUID();
    connectionIds.set(ws, senderId);
    ws.on("message", raw => {
      if (raw.length > MAX_MESSAGE_BYTES) {
        ws.close(1009, "message too large");
        return;
      }

      let message;
      try { message = JSON.parse(raw.toString()); } catch {
        safeSend(ws, { type: "ERROR", message: "INVALID_JSON" });
        return;
      }
      if (!message || typeof message.type !== "string") {
        safeSend(ws, { type: "ERROR", message: "INVALID_MESSAGE" });
        return;
      }

      if (message.type === "JOIN") {
        if (joined || !validToken(message.roomId, MAX_ROOM_ID_LENGTH)) {
          safeSend(ws, { type: "ERROR", message: "INVALID_OR_DUPLICATE_JOIN" });
          ws.close(1008, "invalid join");
          return;
        }
        const roomId = message.roomId;
        let room = rooms.get(roomId);
        if (!room) {
          room = new Set();
          rooms.set(roomId, room);
        }
        if (room.size >= MAX_CLIENTS_PER_ROOM) {
          safeSend(ws, { type: "ERROR", message: "ROOM_FULL" });
          ws.close(1013, "room full");
          return;
        }
        room.add(ws);
        membership.set(ws, roomId);
        joined = true;
        safeSend(ws, { type: "JOINED", roomId, peerId: senderId, peers: room.size - 1 });
        for (const peer of room) {
          if (peer !== ws) safeSend(peer, { type: "PEER_JOINED", peerId: senderId });
        }
        return;
      }

      if (!joined) {
        safeSend(ws, { type: "ERROR", message: "JOIN_REQUIRED" });
        return;
      }
      if (!SIGNAL_TYPES.has(message.type)) {
        safeSend(ws, { type: "ERROR", message: "UNSUPPORTED_SIGNAL_TYPE" });
        return;
      }

      const room = rooms.get(membership.get(ws));
      if (!room) return;
      // Server relays signaling only; SDP and ICE are not treated as trusted.
      // Stamp the transport-assigned sender ID after spreading client data,
      // so spoofed peerId values can never override it.
      const forwarded = { ...message, roomId: membership.get(ws), peerId: senderId };
      for (const peer of room) {
        if (peer !== ws) safeSend(peer, forwarded);
      }
    });

    ws.on("close", () => leave(ws));
    ws.on("error", () => leave(ws));
  });

  wss.on("close", () => {
    for (const ws of membership.keys()) {
      try { ws.close(1001, "signaling relay closing"); } catch {}
    }
    membership.clear();
    rooms.clear();
  });

  return {
    wss,
    get roomCount() { return rooms.size; },
    close: () => wss.close()
  };
}
