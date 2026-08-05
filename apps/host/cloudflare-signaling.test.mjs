import crypto from "node:crypto";
import WebSocket from "ws";

const base = process.env.SIGNAL_BASE;
if (!base?.startsWith("https://")) throw new Error("SIGNAL_BASE is required");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = Array.from(crypto.randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join("");
const secret = crypto.randomBytes(16).toString("hex");
const guest1Id = crypto.randomBytes(8).toString("hex"), guest2Id = crypto.randomBytes(8).toString("hex");

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

const input = (seq, hat, reliability = {}) => JSON.stringify({ type: "input", seq, state: { buttons: 0, hat, lx: 128, ly: 128, rx: 128, ry: 128 }, ...reliability });
const host = new WebSocket(websocketUrl({ role: "host", secret }));
const hostInbox = new Inbox(host); await opened(host);
const ice = await fetch(new URL(`/api/ice/${code}`, base));
if (!ice.ok || !Array.isArray((await ice.json()).iceServers)) throw new Error("ICE endpoint failed");

let guest1 = new WebSocket(websocketUrl({ role: "guest", id: guest1Id, name: "Alice" }));
let guest1Inbox = new Inbox(guest1); await opened(guest1);
await guest1Inbox.until((m) => m.type === "control" && m.active === true);
await hostInbox.until((m) => m.type === "peer-ready" && m.guestId === guest1Id);

const replacedGuestClosed = closed(guest1);
const reconnectedGuest1 = new WebSocket(websocketUrl({ role: "guest", id: guest1Id, name: "Alice" }));
const reconnectedGuest1Inbox = new Inbox(reconnectedGuest1); await opened(reconnectedGuest1);
await reconnectedGuest1Inbox.until((m) => m.type === "control" && m.active === true);
await hostInbox.until((m) => m.type === "peer-ready" && m.guestId === guest1Id);
const replacedGuest = await replacedGuestClosed;
if (replacedGuest.status !== 4001) throw new Error("active controller reconnect did not replace the stale socket");
guest1 = reconnectedGuest1;
guest1Inbox = reconnectedGuest1Inbox;
const guest2 = new WebSocket(websocketUrl({ role: "guest", id: guest2Id, name: "Bob" }));
const guest2Inbox = new Inbox(guest2); await opened(guest2);
await guest2Inbox.until((m) => m.type === "control" && m.active === false);
const joined = await hostInbox.until((m) => m.type === "participants" &&
  m.participants.some((p) => p.name === "Alice") && m.participants.some((p) => p.name === "Bob"));

guest2.send(input(0, 2));
await hostInbox.expectNone((m) => m.type === "input");
guest1.send(input(0, 8, { sid: guest1Id, edges: [[0, 2, 8, 128, 128, 128, 128], [1, 0, 8, 128, 128, 128, 128]] }));
const firstInput = await hostInbox.until((m) => m.type === "input");
if (firstInput.state.hat !== 8) throw new Error("first controller relay failed");
if (firstInput.sid !== guest1Id || firstInput.edges?.length !== 2) throw new Error("digital edge history was not relayed");
host.send(JSON.stringify({ type: "input-ack", seq: firstInput.seq, edgeAck: 1 }));
await guest1Inbox.until((m) => m.type === "input-ack" && m.seq === firstInput.seq && m.edgeAck === 1);
host.send(JSON.stringify({ type: "rumble", seq: 1, strong: 0.75, weak: 0.25, duration: 40 }));
await guest1Inbox.until((m) => m.type === "rumble" && m.seq === 1 && m.strong === 0.75);
await guest2Inbox.expectNone((m) => m.type === "rumble");

guest2.send(JSON.stringify({ type: "claim" }));
await hostInbox.until((m) => m.type === "peer-ready" && m.guestId === guest2Id);
await guest1Inbox.until((m) => m.type === "control" && m.active === false);
await guest2Inbox.until((m) => m.type === "control" && m.active === true);
guest1.send(input(1, 4));
await hostInbox.expectNone((m) => m.type === "input");
guest2.send(input(1, 2));
const secondInput = await hostInbox.until((m) => m.type === "input");
if (secondInput.state.hat !== 2) throw new Error("controller handoff failed");
host.send(JSON.stringify({ type: "input-ack", seq: secondInput.seq }));
await guest2Inbox.until((m) => m.type === "input-ack" && m.seq === secondInput.seq);
host.send(JSON.stringify({ type: "rumble", seq: 2, strong: 0, weak: 1, duration: 40 }));
await guest2Inbox.until((m) => m.type === "rumble" && m.seq === 2 && m.weak === 1);

host.send(JSON.stringify({ type: "release" }));
await hostInbox.until((m) => m.type === "control-released" && m.guestId === guest2Id);
await guest2Inbox.until((m) => m.type === "control" && m.active === false);
guest2.send(input(2, 6));
await hostInbox.expectNone((m) => m.type === "input");

const guest1Closed = closed(guest1), guest2Closed = closed(guest2);
host.send(JSON.stringify({ type: "revoke" }));
const [revoked1, revoked2] = await Promise.all([guest1Closed, guest2Closed]);
if (revoked1.status !== 4002 || revoked2.status !== 4002) throw new Error("session revoke failed");
host.terminate();
console.log("CLOUDFLARE_MULTI_GUEST_E2E_OK=1");
process.exit(0);
