export const RUMBLE_STORAGE_KEY = "switch2RumbleEnabledV1";

export function normalizeRumbleMessage(message) {
  if (message?.type !== "rumble" || !Number.isSafeInteger(message.seq) || message.seq < 0) return null;
  const magnitude = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const strong = magnitude(message.strong), weak = magnitude(message.weak);
  if (strong === null || weak === null) return null;
  const duration = Number.isFinite(message.duration)
    ? Math.max(0, Math.min(100, Math.round(message.duration)))
    : 40;
  return { seq: message.seq, strong, weak, duration };
}

function usableActuator(gamepad) {
  const actuator = gamepad?.vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== "function") return null;
  if (actuator.effects && !Array.from(actuator.effects).includes("dual-rumble")) return null;
  return actuator;
}

function ignorePromise(value) {
  if (value && typeof value.catch === "function") value.catch(() => {});
}

export function createHapticsController({
  getGamepad,
  storage,
  isVisible = () => true,
  onStatus = () => {},
} = {}) {
  let enabled = storage?.getItem(RUMBLE_STORAGE_KEY) !== "0";
  let lastSequence = -1;
  let lastStatus = "";

  function actuator() {
    return usableActuator(getGamepad?.());
  }

  function refresh() {
    const next = !enabled ? "off" : !getGamepad?.() ? "waiting" : actuator() ? "ready" : "unsupported";
    if (next !== lastStatus) {
      lastStatus = next;
      onStatus(next, enabled);
    }
    return next;
  }

  function stop() {
    const target = actuator();
    if (!target) return false;
    if (typeof target.reset === "function") ignorePromise(target.reset());
    else ignorePromise(target.playEffect("dual-rumble", {
      duration: 0, strongMagnitude: 0, weakMagnitude: 0,
    }));
    return true;
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    storage?.setItem(RUMBLE_STORAGE_KEY, enabled ? "1" : "0");
    if (!enabled) stop();
    refresh();
    return enabled;
  }

  function handle(message) {
    const rumble = normalizeRumbleMessage(message);
    if (!rumble || rumble.seq <= lastSequence) return false;
    lastSequence = rumble.seq;
    if (!enabled || !isVisible()) {
      stop();
      refresh();
      return false;
    }
    const target = actuator();
    if (!target) {
      refresh();
      return false;
    }
    if (rumble.duration === 0 || (rumble.strong === 0 && rumble.weak === 0)) {
      stop();
      return true;
    }
    ignorePromise(target.playEffect("dual-rumble", {
      duration: rumble.duration,
      startDelay: 0,
      strongMagnitude: rumble.strong,
      weakMagnitude: rumble.weak,
    }));
    refresh();
    return true;
  }

  refresh();
  return {
    get enabled() { return enabled; },
    handle,
    refresh,
    setEnabled,
    stop,
    toggle: () => setEnabled(!enabled),
  };
}
