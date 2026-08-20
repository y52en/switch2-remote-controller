export async function addIceCandidateOrQueue(peer, candidate, queue) {
  if (!candidate) return;
  if (!peer?.remoteDescription) {
    queue.push(candidate);
    return;
  }
  await peer.addIceCandidate(candidate);
}

export async function drainIceCandidates(peer, queue) {
  if (!peer?.remoteDescription) return;
  while (queue.length) await peer.addIceCandidate(queue.shift());
}
