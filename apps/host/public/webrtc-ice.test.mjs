import assert from "node:assert/strict";
import test from "node:test";
import { addIceCandidateOrQueue, drainIceCandidates } from "./webrtc-ice.js";

test("queues ICE candidates until the remote description exists", async () => {
  const added = [];
  const peer = {
    remoteDescription: null,
    async addIceCandidate(candidate) { added.push(candidate); },
  };
  const queue = [];
  const first = { candidate: "first" };
  const second = { candidate: "second" };

  await addIceCandidateOrQueue(peer, first, queue);
  await addIceCandidateOrQueue(peer, second, queue);
  assert.deepEqual(queue, [first, second]);
  assert.deepEqual(added, []);

  peer.remoteDescription = { type: "offer" };
  await drainIceCandidates(peer, queue);
  assert.deepEqual(queue, []);
  assert.deepEqual(added, [first, second]);
});

test("adds later ICE candidates immediately and ignores empty candidates", async () => {
  const added = [];
  const peer = {
    remoteDescription: { type: "answer" },
    async addIceCandidate(candidate) { added.push(candidate); },
  };
  const queue = [];
  const candidate = { candidate: "ready" };

  await addIceCandidateOrQueue(peer, null, queue);
  await addIceCandidateOrQueue(peer, candidate, queue);
  assert.deepEqual(queue, []);
  assert.deepEqual(added, [candidate]);
});
