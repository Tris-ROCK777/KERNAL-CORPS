import { createMqttSignaling } from "./overseer-signaling-bootstrap.mjs";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

class MockMqttClient extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = [];
    this.publications = [];
    this.unsubscriptions = [];
    this.connected = true;
  }
  subscribe(topic, options) {
    this.subscriptions.push({ topic, options });
  }
  publish(topic, payload, options, callback) {
    this.publications.push({ topic, payload: String(payload), options });
    callback?.();
  }
  unsubscribe(topic) {
    this.unsubscriptions.push(topic);
  }
}

export async function runMqttSignalingVerification() {
  const client = new MockMqttClient();
  const roomId = "kernelRoom_1234567890";
  const a = createMqttSignaling({ client, roomId, peerId: "peer-A" });
  const received = [];
  a.subscribe(message => received.push(message));

  assert.equal(client.subscriptions.length, 1);
  assert.equal(client.subscriptions[0].topic, `kernel-corp/signaling/${roomId}`);

  await a.send({ type: "OFFER", sdp: { type: "offer", sdp: "test-sdp" }, targetPeerId: "peer-B" });
  assert.equal(client.publications.length, 1);
  assert.equal(client.publications[0].topic, `kernel-corp/signaling/${roomId}`);
  const outgoing = JSON.parse(client.publications[0].payload);
  assert.equal(outgoing.peerId, "peer-A");
  assert.equal(outgoing.roomId, roomId);
  assert.equal(outgoing.type, "OFFER");

  const topic = `kernel-corp/signaling/${roomId}`;
  client.emit("message", topic, Buffer.from(JSON.stringify({
    type: "ANSWER", roomId, peerId: "peer-B", sdp: { type: "answer", sdp: "answer-sdp" }
  })));
  assert.equal(received.length, 1);
  assert.equal(received[0].peerId, "peer-B");

  // Ignore self-echoes, wrong rooms, malformed JSON, and unsupported messages.
  client.emit("message", topic, Buffer.from(JSON.stringify({ type: "ICE", roomId, peerId: "peer-A", candidate: {} })));
  client.emit("message", topic, Buffer.from(JSON.stringify({ type: "JOIN", roomId, peerId: "peer-C" })));
  client.emit("message", topic, Buffer.from(JSON.stringify({ type: "ICE", roomId: "otherRoom_1234567890", peerId: "peer-C", candidate: {} })));
  client.emit("message", topic, Buffer.from("{bad-json"));
  assert.equal(received.length, 1);

  a.close();
  assert.deepEqual(client.unsubscriptions, [topic]);
  await assert.rejects(a.send({ type: "ICE", candidate: {} }), /MQTT_SIGNALING_CLOSED/);

  assert.throws(() => createMqttSignaling({ client, roomId: "short", peerId: "peer-A" }), /RANDOM_ROOM_ID/);
  assert.throws(() => createMqttSignaling({ client, roomId, peerId: "peer-A" }).send({ type: "JOIN" }), /UNSUPPORTED_SIGNAL_TYPE/);

  return { status: "ALL_MQTT_SIGNALING_INVARIANTS_PASSED", assertions: 12 };
}
