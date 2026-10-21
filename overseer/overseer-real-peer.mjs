/**
 * KERNEL CORP. — REAL WEBRTC PEER CONNECTOR
 * Browser-native RTCPeerConnection + RTCDataChannel adapter for OverseerMeshReplicator.
 *
 * signalingTransport contract:
 *   send(message): void | Promise<void>
 *   subscribe(handler): unsubscribe function
 * Signaling must route messages to the intended remote peer. This module does not
 * create a signaling server; applications must supply a secure signaling transport.
 */
export async function createRealPeerNode(
  meshReplicator,
  {
    peerId = "remote-peer",
    isInitiator = false,
    signalingTransport,
    iceServers = [{ urls: "stun:stun.l.google.com:19302" }],
    onStateChange = () => {}
  } = {}
) {
  if (!meshReplicator || typeof meshReplicator.attachPeerChannel !== "function") {
    throw new Error("MESH_REPLICATOR_REQUIRED");
  }
  if (!signalingTransport || typeof signalingTransport.send !== "function" ||
      typeof signalingTransport.subscribe !== "function") {
    throw new Error("SIGNALING_TRANSPORT_REQUIRES_SEND_AND_SUBSCRIBE");
  }
  if (typeof RTCPeerConnection !== "function") throw new Error("WEBRTC_UNAVAILABLE");

  const pc = new RTCPeerConnection({ iceServers });
  let dataChannel = null;
  let closed = false;
  let makingOffer = false;
  let offerStarted = false;
  let readyTimer = null;
  const pendingIce = [];
  const send = message => signalingTransport.send({ ...message, peerId });

  const attach = channel => {
    if (closed) { channel.close(); return; }
    dataChannel = channel;
    meshReplicator.attachPeerChannel(peerId, channel);
    channel.addEventListener("open", () => onStateChange({ type: "datachannel", state: "open", peerId }));
    channel.addEventListener("close", () => onStateChange({ type: "datachannel", state: "closed", peerId }));
  };

  pc.addEventListener("icecandidate", event => {
    if (event.candidate) {
      Promise.resolve(send({ type: "ICE", candidate: event.candidate.toJSON?.() ?? event.candidate, targetPeerId: remotePeerId }))
        .catch(error => onStateChange({ type: "signaling-error", error: String(error) }));
    }
  });
  pc.addEventListener("connectionstatechange", () =>
    onStateChange({ type: "connection", state: pc.connectionState, iceState: pc.iceConnectionState, peerId }));
  pc.addEventListener("datachannel", event => attach(event.channel));
  if (isInitiator) attach(pc.createDataChannel("kernel-mesh", { ordered: true }));

  async function drainIce() {
    while (pendingIce.length) await pc.addIceCandidate(pendingIce.shift());
  }

  async function handleSignal(message) {
    if (closed || !message || typeof message.type !== "string") return;
    try {
      switch (message.type) {
        case "READY": {
          if (!isInitiator || offerStarted) break;
          offerStarted = true;
          makingOffer = true;
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await send({ type: "OFFER", sdp: pc.localDescription, targetPeerId: remotePeerId });
          } finally { makingOffer = false; }
          break;
        }
        case "OFFER": {
          if (!message.sdp) throw new Error("OFFER_SDP_REQUIRED");
          if (readyTimer !== null) { clearInterval(readyTimer); readyTimer = null; }
          await pc.setRemoteDescription(message.sdp);
          await drainIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await send({ type: "ANSWER", sdp: pc.localDescription, targetPeerId: remotePeerId });
          break;
        }
        case "ANSWER":
          if (!isInitiator || !message.sdp) throw new Error("UNEXPECTED_OR_INVALID_ANSWER");
          await pc.setRemoteDescription(message.sdp);
          await drainIce();
          break;
        case "ICE":
          if (!message.candidate) throw new Error("ICE_CANDIDATE_REQUIRED");
          if (!pc.remoteDescription) pendingIce.push(message.candidate);
          else await pc.addIceCandidate(message.candidate);
          break;
        case "ERROR":
          onStateChange({ type: "signaling-error", error: message.message || "REMOTE_SIGNALING_ERROR" });
          break;
        default:
          throw new Error("UNKNOWN_SIGNALING_MESSAGE");
      }
    } catch (error) {
      onStateChange({ type: "signaling-error", error: String(error), message });
    }
  }

  const unsubscribe = signalingTransport.subscribe(handleSignal);
  if (!isInitiator) {
    // Repeat READY until the offer arrives; MQTT QoS 0 can lose early messages
    // while the other peer is still subscribing or registering its listener.
    const announceReady = () => Promise.resolve(send({ type: "READY" }))
      .catch(error => onStateChange({ type: "signaling-error", error: String(error) }));
    await announceReady();
    readyTimer = setInterval(announceReady, 1500);
  }

  return {
    pc,
    getDataChannel: () => dataChannel,
    get makingOffer() { return makingOffer; },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      if (readyTimer !== null) { clearInterval(readyTimer); readyTimer = null; }
      meshReplicator.detachPeerChannel(peerId);
      dataChannel?.close();
      pc.close();
      onStateChange({ type: "closed", peerId });
    }
  };
}
