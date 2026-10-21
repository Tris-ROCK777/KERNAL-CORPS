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
      if (!payload || !["READY", "OFFER", "ANSWER", "ICE"].includes(payload.type)) {
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


/**
 * TEST-ONLY BROADCAST RELAY ADAPTER (e.g. SocketsBay demo endpoint).
 *
 * Unlike createEphemeralSignaling(), this mode does not send JOIN or wait for
 * JOINED: generic broadcast relays usually do not implement room membership.
 * Room filtering is client-side only. Every client on the public relay may see
 * signaling packets, so use only for non-sensitive smoke tests with a random
 * room ID. Do not treat this as an authenticated/private production broker.
 *
 * This adapter is suitable for a two-peer handshake test. A true multi-peer
 * mesh still needs recipient-targeted signaling in the peer connector.
 */
export function createBroadcastSignaling({
  url = "wss://socketsbay.com/wss/v2/2/demo/",
  roomId,
  peerId,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 10000
} = {}) {
  if (typeof url !== "string" || !/^wss:\/\//.test(url)) {
    throw new Error("SECURE_PUBLIC_RELAY_URL_REQUIRED");
  }
  if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(roomId)) {
    throw new Error("USE_RANDOM_ROOM_ID_FOR_PUBLIC_RELAY");
  }
  if (typeof peerId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(peerId)) {
    throw new Error("VALID_PEER_ID_REQUIRED");
  }
  if (typeof WebSocketImpl !== "function") throw new Error("WEBSOCKET_UNAVAILABLE");

  const ws = new WebSocketImpl(url);
  const listeners = new Set();
  let closed = false;
  let connectionTimer;

  const ready = new Promise((resolve, reject) => {
    connectionTimer = setTimeout(() => {
      if (ws.readyState !== WebSocketImpl.OPEN) {
        reject(new Error("BROADCAST_RELAY_CONNECT_TIMEOUT"));
        ws.close();
      }
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(connectionTimer);
      resolve();
    });

    ws.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message || message.roomId !== roomId || message.peerId === peerId) return;
      if (!["READY", "OFFER", "ANSWER", "ICE", "ERROR"].includes(message.type)) return;
      for (const listener of listeners) {
        try { listener(message); } catch {}
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(connectionTimer);
      reject(new Error("BROADCAST_RELAY_SOCKET_ERROR"));
    });

    ws.addEventListener("close", () => {
      closed = true;
      clearTimeout(connectionTimer);
      for (const listener of listeners) {
        try { listener({ type: "ERROR", message: "BROADCAST_RELAY_CLOSED" }); } catch {}
      }
    });
  });

  return {
    ready,
    async send(payload) {
      await ready;
      if (closed || ws.readyState !== WebSocketImpl.OPEN) {
        throw new Error("BROADCAST_RELAY_NOT_OPEN");
      }
      if (!payload || !["READY", "OFFER", "ANSWER", "ICE"].includes(payload.type)) {
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
      clearTimeout(connectionTimer);
      listeners.clear();
      ws.close(1000, "signaling bootstrap closed");
    },
    get readyState() { return ws.readyState; }
  };
}


/**
 * MQTT-over-WebSocket signaling adapter.
 *
 * Pass a connected MQTT.js/Paho-compatible client. The broker transports MQTT
 * messages; it is NOT a raw JSON WebSocket endpoint. Public brokers are shared:
 * use a random roomId and never send secrets or private application data.
 *
 * client contract: connected, subscribe(topic), publish(topic, payload),
 * on("message", (topic, payload) => ...), end()/close().
 */
export function createMqttSignaling({
  client,
  roomId,
  peerId,
  topicPrefix = "kernel-corp/signaling",
  closeClient = false
} = {}) {
  if (!client || typeof client.subscribe !== "function" ||
      typeof client.publish !== "function" || typeof client.on !== "function") {
    throw new Error("CONNECTED_MQTT_CLIENT_REQUIRED");
  }
  if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(roomId)) {
    throw new Error("USE_RANDOM_ROOM_ID_FOR_PUBLIC_BROKER");
  }
  if (typeof peerId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(peerId)) {
    throw new Error("VALID_PEER_ID_REQUIRED");
  }
  if (typeof topicPrefix !== "string" ||
      !/^[A-Za-z0-9_/-]{1,96}$/.test(topicPrefix) ||
      topicPrefix.includes("//") || topicPrefix.startsWith("/") || topicPrefix.endsWith("/")) {
    throw new Error("INVALID_MQTT_TOPIC_PREFIX");
  }

  const topic = `${topicPrefix}/${roomId}`;
  const listeners = new Set();
  let closed = false;

  const onMessage = (receivedTopic, rawPayload) => {
    if (closed || receivedTopic !== topic) return;
    let message;
    try {
      const raw = typeof rawPayload === "string"
        ? rawPayload
        : new TextDecoder().decode(rawPayload);
      message = JSON.parse(raw);
    } catch { return; }
    if (!message || message.roomId !== roomId || message.peerId === peerId) return;
    if (!["READY", "OFFER", "ANSWER", "ICE", "ERROR"].includes(message.type)) return;
    for (const listener of listeners) {
      try { listener(message); } catch {}
    }
  };

  client.on("message", onMessage);
  client.subscribe(topic, { qos: 0 });

  return {
    topic,
    ready: Promise.resolve(),
    async send(payload) {
      if (closed) throw new Error("MQTT_SIGNALING_CLOSED");
      if (!payload || !["OFFER", "ANSWER", "ICE"].includes(payload.type)) {
        throw new Error("UNSUPPORTED_SIGNAL_TYPE");
      }
      const packet = JSON.stringify({ ...payload, roomId, peerId });
      await new Promise((resolve, reject) => {
        client.publish(topic, packet, { qos: 0, retain: false }, error => {
          if (error) reject(error);
          else resolve();
        });
      });
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
      listeners.clear();
      if (typeof client.removeListener === "function") client.removeListener("message", onMessage);
      else if (typeof client.off === "function") client.off("message", onMessage);
      if (closeClient) {
        if (typeof client.end === "function") client.end(true);
        else if (typeof client.close === "function") client.close();
      } else {
        client.unsubscribe?.(topic);
      }
    }
  };
}
