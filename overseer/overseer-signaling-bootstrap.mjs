/**
 * KERNEL CORP. — EPHEMERAL WEBRTC SIGNALING BOOTSTRAP
 *
 * Uses a caller-supplied public WebSocket room relay only for SDP/ICE exchange.
 * Once the RTCDataChannel opens, call close() to drop signaling.
 *
 * Important: a WebSocket echo endpoint is NOT a multi-peer room relay. The
 * endpoint must forward each client's messages to other clients in the same
 * room. No WebRTC data channel can bootstrap its own first connection.
 */
export function createEphemeralSignaling({
  url,
  roomId,
  peerId,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 10000
} = {}) {
  if (typeof url !== "string" || !/^wss:\/\//.test(url)) {
    throw new Error("SECURE_PUBLIC_RELAY_URL_REQUIRED");
  }
  if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(roomId)) {
    throw new Error("VALID_ROOM_ID_REQUIRED");
  }
  if (typeof peerId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(peerId)) {
    throw new Error("VALID_PEER_ID_REQUIRED");
  }
  if (typeof WebSocketImpl !== "function") throw new Error("WEBSOCKET_UNAVAILABLE");

  const ws = new WebSocketImpl(url);
  const listeners = new Set();
  let closed = false;
  let joined = false;
  let joinTimer;

  const ready = new Promise((resolve, reject) => {
    joinTimer = setTimeout(() => {
      if (!joined) {
        reject(new Error("SIGNALING_JOIN_TIMEOUT"));
        ws.close();
      }
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "JOIN", roomId, peerId }));
    });

    ws.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.roomId !== roomId) return;

      if (message.type === "JOINED" && message.peerId === peerId) {
        joined = true;
        clearTimeout(joinTimer);
        resolve();
        return;
      }

      // Never feed our own reflected messages back into the peer connector.
      if (message.peerId === peerId) return;
      for (const listener of listeners) {
        try { listener(message); } catch {}
      }
    });

    ws.addEventListener("error", () => {
      if (!joined) reject(new Error("SIGNALING_SOCKET_ERROR"));
    });

    ws.addEventListener("close", () => {
      closed = true;
      clearTimeout(joinTimer);
      if (!joined) reject(new Error("SIGNALING_SOCKET_CLOSED_BEFORE_JOIN"));
      for (const listener of listeners) {
        try { listener({ type: "ERROR", message: "SIGNALING_SOCKET_CLOSED" }); } catch {}
      }
    });
  });

  return {
    ready,
    async send(payload) {
      await ready;
      if (closed || ws.readyState !== WebSocketImpl.OPEN) {
        throw new Error("SIGNALING_SOCKET_NOT_OPEN");
      }
      if (!payload || !["OFFER", "ANSWER", "ICE"].includes(payload.type)) {
        throw new Error("UNSUPPORTED_SIGNAL_TYPE");
      }
      ws.send(JSON.stringify({ ...payload, roomId, peerId }));
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new Error("SIGNALING_LISTENER_REQUIRED");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onMessage(listener) {
      return this.subscribe(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(joinTimer);
      listeners.clear();
      ws.close(1000, "direct WebRTC established or bootstrap cancelled");
    },
    get readyState() { return ws.readyState; }
  };
}
