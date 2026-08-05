const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const ID_PATTERN = /^[0-9a-f]{16}$/;
const SIGNAL_TYPES = new Set(["offer", "answer", "ice"]);
const MAX_GUESTS = 16;

function validRumble(message) {
  return message?.type === "rumble" &&
    Number.isSafeInteger(message.seq) && message.seq >= 0 &&
    Number.isFinite(message.strong) && message.strong >= 0 && message.strong <= 1 &&
    Number.isFinite(message.weak) && message.weak >= 0 && message.weak <= 1 &&
    Number.isInteger(message.duration) && message.duration >= 0 && message.duration <= 100;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomMatch = url.pathname.match(/^\/api\/room\/([A-Z2-9]+)$/);
    const iceMatch = url.pathname.match(/^\/api\/ice\/([A-Z2-9]+)$/);
    const code = roomMatch?.[1] || iceMatch?.[1];
    if (code) {
      if (!CODE_PATTERN.test(code)) return new Response("invalid code", { status: 400 });
      return env.ROOMS.getByName(code).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class ControlRoom {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes("/api/ice/")) return this.issueIce(request);
    if (request.headers.get("Upgrade") !== "websocket") return new Response("websocket required", { status: 426 });
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "guest") return new Response("invalid role", { status: 400 });
    let attachment;
    if (role === "host") {
      const secret = url.searchParams.get("secret") || "";
      if (!/^[0-9a-f]{32}$/.test(secret)) return new Response("invalid secret", { status: 403 });
      const stored = await this.state.storage.get("hostSecret");
      if (stored && stored !== secret) return new Response("host conflict", { status: 409 });
      if (!stored) await this.state.storage.put("hostSecret", secret);
      attachment = { role };
    } else {
      const guestId = url.searchParams.get("id") || "";
      const name = (url.searchParams.get("name") || "ゲスト").trim().slice(0, 32);
      if (!ID_PATTERN.test(guestId) || !name) return new Response("invalid guest", { status: 400 });
      if (this.state.getWebSockets("host").length !== 1) return new Response("host unavailable", { status: 409 });
      if (this.state.getWebSockets("guest").length >= MAX_GUESTS && !this.state.getWebSockets(`guest:${guestId}`).length) return new Response("room full", { status: 429 });
      for (const existing of this.state.getWebSockets(`guest:${guestId}`)) existing.close(4001, "reconnected");
      attachment = { role, guestId, name };
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tags = role === "host" ? ["host"] : ["guest", `guest:${attachment.guestId}`];
    this.state.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    if (role === "host") {
      for (const existing of this.state.getWebSockets("host")) if (existing !== server) existing.close(4001, "host replaced");
      this.sendParticipants();
      const activeGuestId = await this.state.storage.get("activeGuestId");
      if (activeGuestId && this.state.getWebSockets(`guest:${activeGuestId}`).length) server.send(JSON.stringify({ type: "peer-ready", guestId: activeGuestId }));
    } else {
      this.sendParticipants();
      const activeGuestId = await this.state.storage.get("activeGuestId");
      if (!activeGuestId) {
        await this.state.storage.put("activeGuestId", attachment.guestId);
        this.broadcastControl(attachment.guestId);
        this.sendTo("host", JSON.stringify({ type: "peer-ready", guestId: attachment.guestId }));
        this.sendParticipants();
      } else {
        server.send(JSON.stringify({ type: "control", active: activeGuestId === attachment.guestId }));
        if (activeGuestId === attachment.guestId) {
          this.sendTo("host", JSON.stringify({ type: "peer-ready", guestId: attachment.guestId }));
        }
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  iceResponse(request, value, init = {}) {
    const origin = request.headers.get("Origin");
    const headers = new Headers(init.headers);
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
    }
    return Response.json(value, { ...init, headers });
  }

  async issueIce(request) {
    if (!this.state.getWebSockets().length) return new Response("inactive room", { status: 404 });
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) return this.iceResponse(request, { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    const cached = await this.state.storage.get("ice");
    if (cached?.expires > Date.now()) return this.iceResponse(request, cached.value);
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST", headers: { Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ ttl: 3600 }),
    });
    if (!response.ok) return this.iceResponse(request, { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    const value = await response.json();
    await this.state.storage.put("ice", { value, expires: Date.now() + 55 * 60 * 1000 });
    return this.iceResponse(request, value);
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== "string" || raw.length > 32768) return socket.close(1009, "message too large");
    let message; try { message = JSON.parse(raw); } catch { return socket.close(1003, "invalid json"); }
    const { role, guestId } = socket.deserializeAttachment() || {};
    if (role === "guest" && message.type === "claim") {
      const previous = await this.state.storage.get("activeGuestId");
      await this.state.storage.put("activeGuestId", guestId);
      this.broadcastControl(guestId);
      this.sendTo("host", JSON.stringify({ type: "control-released", guestId: previous || null }));
      this.sendTo("host", JSON.stringify({ type: "peer-ready", guestId }));
      this.sendParticipants();
      return;
    }
    if (role === "guest" && message.type === "grant") {
      if (!ID_PATTERN.test(message.guestId) || !this.state.getWebSockets(`guest:${message.guestId}`).length) return;
      const previous = await this.state.storage.get("activeGuestId");
      await this.state.storage.put("activeGuestId", message.guestId);
      this.broadcastControl(message.guestId);
      this.sendTo("host", JSON.stringify({ type: "control-released", guestId: previous || null }));
      this.sendTo("host", JSON.stringify({ type: "peer-ready", guestId: message.guestId }));
      this.sendParticipants();
      return;
    }
    if (role === "host" && message.type === "release") {
      const previous = await this.state.storage.get("activeGuestId");
      await this.state.storage.delete("activeGuestId");
      this.broadcastControl(null);
      this.sendTo("host", JSON.stringify({ type: "control-released", guestId: previous || null }));
      this.sendParticipants();
      return;
    }
    if (role === "host" && message.type === "revoke") {
      await this.state.storage.delete("activeGuestId");
      for (const guest of this.state.getWebSockets("guest")) guest.close(4002, "session ended by host");
      return;
    }
    const activeGuestId = await this.state.storage.get("activeGuestId");
    if (role === "guest" && message.type === "input") {
      if (guestId !== activeGuestId) return;
      if (raw.length > 2048 || !Number.isSafeInteger(message.seq) || message.seq < 0 || typeof message.state !== "object" || message.state === null) return socket.close(1008, "invalid input");
      this.sendTo("host", raw);
      return;
    }
    if (role === "host" && message.type === "input-ack") {
      if (!activeGuestId || !Number.isSafeInteger(message.seq) || message.seq < 0) return;
      this.sendToGuest(activeGuestId, message);
      return;
    }
    if (role === "host" && message.type === "rumble") {
      if (!activeGuestId || !validRumble(message)) return;
      this.sendToGuest(activeGuestId, {
        type: "rumble", seq: message.seq, strong: message.strong,
        weak: message.weak, duration: message.duration,
      });
      return;
    }
    if (SIGNAL_TYPES.has(message.type)) {
      const allowed = (role === "host" && ["offer", "ice"].includes(message.type)) || (role === "guest" && guestId === activeGuestId && ["answer", "ice"].includes(message.type));
      if (!allowed || !activeGuestId) return;
      if (role === "host") this.sendToGuest(activeGuestId, message); else this.sendTo("host", raw);
    }
  }

  async webSocketClose(socket, code, reason) {
    const { role, guestId } = socket.deserializeAttachment() || {};
    if (role === "host" && this.state.getWebSockets("host").length === 0) for (const guest of this.state.getWebSockets("guest")) guest.close(4003, "host disconnected");
    if (role === "guest") {
      const activeGuestId = await this.state.storage.get("activeGuestId");
      if (guestId === activeGuestId && this.state.getWebSockets(`guest:${guestId}`).length === 0) {
        await this.state.storage.delete("activeGuestId");
        this.sendTo("host", JSON.stringify({ type: "control-released", guestId }));
      }
      this.sendParticipants();
    }
    try { socket.close(code, reason); } catch { }
  }

  participantList() {
    return this.state.getWebSockets("guest").map((guest) => {
      const { guestId: id, name } = guest.deserializeAttachment();
      return { id, name };
    });
  }
  async sendParticipants() {
    const activeGuestId = await this.state.storage.get("activeGuestId");
    const participants = this.participantList().map((guest) => ({ ...guest, active: guest.id === activeGuestId }));
    const message = JSON.stringify({ type: "participants", participants });
    this.sendTo("host", message);
    this.sendTo("guest", message);
  }
  broadcastControl(activeGuestId) {
    for (const guest of this.state.getWebSockets("guest")) {
      const { guestId } = guest.deserializeAttachment();
      try { guest.send(JSON.stringify({ type: "control", active: guestId === activeGuestId })); } catch { }
    }
  }
  sendToGuest(guestId, message) {
    const raw = typeof message === "string" ? message : JSON.stringify(message);
    for (const socket of this.state.getWebSockets(`guest:${guestId}`)) try { socket.send(raw); } catch { }
  }
  sendTo(role, message) {
    for (const socket of this.state.getWebSockets(role)) try { socket.send(message); } catch { }
  }
}
