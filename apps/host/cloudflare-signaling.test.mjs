import crypto from "node:crypto";
import WebSocket from "ws";

const base = process.env.SIGNAL_BASE;
if (!base?.startsWith("https://")) throw new Error("SIGNAL_BASE is required");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = Array.from(crypto.randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join("");
const secret = crypto.randomBytes(16).toString("hex");
const guestIds = Array.from({ length: 4 }, () => crypto.randomBytes(8).toString("hex"));

const websocketUrl = (params) => {
  const url = new URL(`/api/room/${code}`, base); url.protocol = "wss:";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
};
const opened = (socket) => new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
const closed = (socket) => new Promise((resolve) => socket.once("close", (status, reason) => resolve({ status, reason: reason.toString() })));

class Inbox {
  constructor(socket) {
    this.messages = []; this.waiters = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = this.waiters.shift(); if (waiter) waiter(message); else this.messages.push(message);
    });
  }
  next(timeout = 15000) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return Promise.race([
      new Promise((resolve) => this.waiters.push(resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("message timeout")), timeout)),
    ]);
  }
  async until(predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const message = await this.next(deadline - Date.now());
      if (predicate(message)) return message;
    }
    throw new Error("matching message timeout");
  }
  async expectNone(predicate, timeout = 350) {
    await new Promise((resolve) => setTimeout(resolve, timeout));
    const index = this.messages.findIndex(predicate);
    if (index >= 0) throw new Error(`unexpected message: ${JSON.stringify(this.messages[index])}`);
  }
}

const input = (seq, hat, reliability = {}) => JSON.stringify({
  type: "input", seq,
  state: { buttons: 0, hat, lx: 128, ly: 128, rx: 128, ry: 128 },
  ...reliability,
});
const host = new WebSocket(websocketUrl({ role: "host", secret }));
const hostInbox = new Inbox(host); await opened(host);
const ice = await fetch(new URL(`/api/ice/${code}`, base));
if (!ice.ok || !Array.isArray((await ice.json()).iceServers)) throw new Error("ICE endpoint failed");

const names = ["Alice", "Bob", "Carol", "Dave"];
const guests = [];
const guestInboxes = [];
for (let index = 0; index < names.length; index += 1) {
  const guest = new WebSocket(websocketUrl({ role: "guest", id: guestIds[index], name: names[index] }));
  const inbox = new Inbox(guest);
  await opened(guest);
  const expectedSlot = index < 3 ? index : null;
  await inbox.until((message) => message.type === "control" &&
    message.active === (expectedSlot !== null) && message.slot === expectedSlot);
  if (expectedSlot !== null) {
    await hostInbox.until((message) => message.type === "peer-ready" &&
      message.guestId === guestIds[index] && message.slot === expectedSlot);
  }
  guests.push(guest);
  guestInboxes.push(inbox);
}

const replacedGuestClosed = closed(guests[0]);
const reconnectedGuest = new WebSocket(websocketUrl({ role: "guest", id: guestIds[0], name: names[0] }));
const reconnectedInbox = new Inbox(reconnectedGuest); await opened(reconnectedGuest);
await reconnectedInbox.until((message) => message.type === "control" && message.active && message.slot === 0);
await hostInbox.until((message) => message.type === "peer-ready" && message.guestId === guestIds[0] && message.slot === 0);
const replacedGuest = await replacedGuestClosed;
if (replacedGuest.status !== 4001) throw new Error("controller reconnect did not replace the stale socket");
guests[0] = reconnectedGuest;
guestInboxes[0] = reconnectedInbox;

for (let slot = 0; slot < 3; slot += 1) {
  guests[slot].send(input(slot, slot * 2, slot === 0 ? {
    sid: guestIds[slot],
    edges: [[0, 2, 8, 128, 128, 128, 128], [1, 0, 8, 128, 128, 128, 128]],
  } : {}));
}
const inputs = new Map();
while (inputs.size < 3) {
  const message = await hostInbox.until((candidate) => candidate.type === "input");
  inputs.set(message.slot, message);
}
for (let slot = 0; slot < 3; slot += 1) {
  if (inputs.get(slot)?.guestId !== guestIds[slot]) throw new Error(`slot ${slot} relay routed to the wrong guest`);
}
if (inputs.get(0).edges?.length !== 2) throw new Error("digital edge history was not relayed");

guests[3].send(input(9, 6));
await hostInbox.expectNone((message) => message.type === "input" && message.guestId === guestIds[3]);

host.send(JSON.stringify({ type: "input-ack", slot: 1, seq: inputs.get(1).seq, edgeAck: 4 }));
await guestInboxes[1].until((message) => message.type === "input-ack" && message.slot === 1 && message.edgeAck === 4);
for (const inbox of [guestInboxes[0], guestInboxes[2], guestInboxes[3]]) {
  await inbox.expectNone((message) => message.type === "input-ack" && message.slot === 1);
}

host.send(JSON.stringify({ type: "rumble", slot: 2, seq: 1, strong: 0.75, weak: 0.25, duration: 40 }));
await guestInboxes[2].until((message) => message.type === "rumble" && message.slot === 2 && message.seq === 1);
for (const inbox of [guestInboxes[0], guestInboxes[1], guestInboxes[3]]) {
  await inbox.expectNone((message) => message.type === "rumble" && message.slot === 2);
}

host.send(JSON.stringify({ type: "release", slot: 1 }));
await hostInbox.until((message) => message.type === "control-released" && message.guestId === guestIds[1] && message.slot === 1);
await guestInboxes[1].until((message) => message.type === "control" && message.active === false);
guests[3].send(JSON.stringify({ type: "claim", slot: 1 }));
await hostInbox.until((message) => message.type === "peer-ready" && message.guestId === guestIds[3] && message.slot === 1);
await guestInboxes[3].until((message) => message.type === "control" && message.active && message.slot === 1);
guests[3].send(input(10, 6));
const claimedInput = await hostInbox.until((message) => message.type === "input" && message.guestId === guestIds[3]);
if (claimedInput.slot !== 1 || claimedInput.state.hat !== 6) throw new Error("released slot claim failed");

const closePromises = guests.map(closed);
host.send(JSON.stringify({ type: "revoke" }));
const revoked = await Promise.all(closePromises);
if (revoked.some(({ status }) => status !== 4002)) throw new Error("session revoke failed");
host.terminate();
console.log("CLOUDFLARE_THREE_CONTROLLER_E2E_OK=1");
process.exit(0);
