import assert from "node:assert/strict";
import { createRealPeerNode } from "./overseer-real-peer.mjs";

class FakeChannel {
  constructor() { this.readyState = "open"; this.label = "kernel-mesh"; this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  close() { this.readyState = "closed"; }
}

class FakeRTCPeerConnection {
  constructor() { this.listeners = new Map(); this.localDescription = null; this.remoteDescription = null; this.connectionState = "new"; this.iceConnectionState = "new"; this.addedIce = []; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
  createDataChannel() { return new FakeChannel(); }
  async createOffer() { return { type: "offer", sdp: "fake-offer" }; }
  async createAnswer() { return { type: "answer", sdp: "fake-answer" }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { this.addedIce.push(value); }
  close() {}
}

function fakeSignaling() {
  const listeners = new Set();
  return {
    sent: [],
    async send(message) { this.sent.push(message); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(message) { for (const listener of listeners) listener(message); }
  };
}

export async function runRealPeerVerification() {
  const Original = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection;
  try {
    const signaling = fakeSignaling();
    const mesh = { attachPeerChannel() {}, detachPeerChannel() {} };
    const node = await createRealPeerNode(mesh, {
      peerId: "local-alias", isInitiator: true, signalingTransport: signaling
    });
    signaling.emit({ type: "READY", peerId: "remote-actual-id" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const offer = signaling.sent.find(item => item.type === "OFFER");
    assert.ok(offer, "initiator should send an offer after READY");
    assert.equal(offer.targetPeerId, "remote-actual-id", "offer must target actual remote identity");
    node.pc.emit("icecandidate", { candidate: { toJSON: () => ({ candidate: "fake-ice" }) } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const ice = signaling.sent.find(item => item.type === "ICE");
    assert.equal(ice?.targetPeerId, "remote-actual-id", "ICE must target the same remote identity");
    signaling.emit({ type: "ANSWER", peerId: "remote-actual-id", sdp: { type: "answer", sdp: "fake-answer" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(node.pc.remoteDescription?.type, "answer");
    node.close();
    return { status: "ALL_REAL_PEER_SIGNALING_INVARIANTS_PASSED", assertions: 4 };
  } finally {
    if (Original === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = Original;
  }
}
