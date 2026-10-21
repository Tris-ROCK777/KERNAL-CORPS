/**
 * KERNEL CORP. — BROWSER WEBSOCKET SIGNALING TRANSPORT
 * Client adapter for server-signaling.mjs and overseer-real-peer.mjs.
 *
 * Example:
 *   const signaling = await createWebSocketSignalingTransport({
 *     url: "wss://YOUR-HOST/kernel-signal",
 *     roomId: "private-room-token"
 *   });
 *   const peer = await createRealPeerNode(mesh, { isInitiator: true, signalingTransport: signaling });
 */
export async function createWebSocketSignalingTransport({
  url,
  roomId,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 10000
} = {}) {
  if (typeof url !== "string" || !/^wss:\/\//.test(url)) {
    throw new Error("SECURE_WSS_URL_REQUIRED");
  }
  if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(roomId)) {
    throw new Error("VALID_ROOM_ID_REQUIRED");
  }
  if (typeof WebSocketImpl !== "function") throw new Error("WEBSOCKET_UNAVAILABLE");

  const socket = new WebSocketImpl(url);
  const listeners = new Set();
  let settled = false;
  let closed = false;
  let assignedPeerId;
  let joinTimer;

  const ready = new Promise((resolve, reject) => {
    const cleanupTimer = () => {
      if (joinTimer) clearTimeout(joinTimer);
      joinTimer = undefined;
    };
    joinTimer = setTimeout(() => {
      cleanupTimer();
      if (!settled) {
        settled = true;
        reject(new Error("SIGNALING_JOIN_TIMEOUT"));
        socket.close();
      }
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "JOIN", roomId }));
    });

    socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.type === "JOINED") {
        if (message.roomId !== roomId ||
            typeof message.peerId !== "string" ||
            !/^[A-Za-z0-9_-]{1,96}$/.test(message.peerId)) {
          cleanupTimer();
          if (!settled) {
            settled = true;
            reject(new Error("INVALID_SIGNALING_JOIN_ACK"));
            socket.close(1008, "invalid join acknowledgement");
          }
          return;
        }
        assignedPeerId = message.peerId;
        cleanupTimer();
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      if (message?.type !== "ERROR" && message?.roomId !== roomId) return;
      if (message?.peerId === assignedPeerId) return;
      if (message?.type === "ERROR" && !settled) {
        cleanupTimer();
        settled = true;
        reject(new Error(message.message || "SIGNALING_JOIN_FAILED"));
        return;
      }
      for (const listener of listeners) {
        try { listener(message); } catch {}
      }
    });

    socket.addEventListener("error", () => {
      if (!settled) {
        cleanupTimer();
        settled = true;
        reject(new Error("SIGNALING_SOCKET_ERROR"));
      }
    });

    socket.addEventListener("close", () => {
      closed = true;
      cleanupTimer();
      if (!settled) {
        settled = true;
        reject(new Error("SIGNALING_SOCKET_CLOSED_BEFORE_JOIN"));
      }
      for (const listener of listeners) {
        try { listener({ type: "ERROR", message: "SIGNALING_SOCKET_CLOSED" }); } catch {}
      }
    });
  });

  await ready;

  return {
    ready,
    get peerId() { return assignedPeerId; },
    send(message) {
      if (closed || socket.readyState !== WebSocketImpl.OPEN) {
        throw new Error("SIGNALING_SOCKET_NOT_OPEN");
      }
      if (!message || !["OFFER", "ANSWER", "ICE"].includes(message.type)) {
        throw new Error("UNSUPPORTED_SIGNAL_TYPE");
      }
      socket.send(JSON.stringify(message));
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new Error("SIGNALING_LISTENER_REQUIRED");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      socket.close(1000, "client closing");
    },
    get readyState() { return socket.readyState; }
  };
}
