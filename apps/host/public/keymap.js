const STORAGE_KEY = "switch2KeyboardBindingsV2";

const actions = [
  { id: "lstick-up", label: "左スティック ↑", type: "stick", side: "left", direction: "up", binding: { code: "KeyW" } },
  { id: "lstick-left", label: "左スティック ←", type: "stick", side: "left", direction: "left", binding: { code: "KeyA" } },
  { id: "lstick-down", label: "左スティック ↓", type: "stick", side: "left", direction: "down", binding: { code: "KeyS" } },
  { id: "lstick-right", label: "左スティック →", type: "stick", side: "left", direction: "right", binding: { code: "KeyD" } },
  { id: "up", label: "十字 ↑", type: "hat", value: 0, binding: { code: "KeyW", shift: true } },
  { id: "left", label: "十字 ←", type: "hat", value: 6, binding: { code: "KeyA", shift: true } },
  { id: "down", label: "十字 ↓", type: "hat", value: 4, binding: { code: "KeyS", shift: true } },
  { id: "right", label: "十字 →", type: "hat", value: 2, binding: { code: "KeyD", shift: true } },
  { id: "rstick-up", label: "右スティック ↑", type: "stick", side: "right", direction: "up", binding: { code: "ArrowUp" } },
  { id: "rstick-left", label: "右スティック ←", type: "stick", side: "right", direction: "left", binding: { code: "ArrowLeft" } },
  { id: "rstick-down", label: "右スティック ↓", type: "stick", side: "right", direction: "down", binding: { code: "ArrowDown" } },
  { id: "rstick-right", label: "右スティック →", type: "stick", side: "right", direction: "right", binding: { code: "ArrowRight" } },
  { id: "a", label: "A", type: "button", value: 2, binding: { code: "KeyL" } },
  { id: "b", label: "B", type: "button", value: 1, binding: { code: "KeyK" } },
  { id: "x", label: "X", type: "button", value: 3, binding: { code: "KeyI" } },
  { id: "y", label: "Y", type: "button", value: 0, binding: { code: "KeyJ" } },
  { id: "l", label: "L", type: "button", value: 4, binding: { code: "KeyQ" } },
  { id: "zl", label: "ZL", type: "button", value: 6, binding: { code: "KeyE" } },
  { id: "zr", label: "ZR", type: "button", value: 7, binding: { code: "KeyU" } },
  { id: "r", label: "R", type: "button", value: 5, binding: { code: "KeyO" } },
  { id: "minus", label: "−", type: "button", value: 8, binding: { code: "KeyV" } },
  { id: "plus", label: "＋", type: "button", value: 9, binding: { code: "KeyN" } },
  { id: "home", label: "HOME", type: "button", value: 12, binding: { code: "KeyB" } },
  { id: "capture", label: "スクショ", type: "button", value: 13, binding: { code: "Space" } },
  { id: "lstick", label: "左スティック押し込み", type: "button", value: 10, binding: { code: "KeyX" } },
  { id: "rstick", label: "右スティック押し込み", type: "button", value: 11, binding: { code: "KeyM" } },
  { id: "claim", label: "操作権を取る", type: "claim", binding: { code: "Enter" } },
];

const defaults = () => Object.fromEntries(actions.map(({ id, binding }) => [id, { ...binding }]));
const modifiers = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

export function defaultKeyboardBindings() {
  return defaults();
}

function validBinding(binding) {
  return binding && typeof binding.code === "string" &&
    ["shift", "ctrl", "alt", "meta"].every((key) => binding[key] === undefined || typeof binding[key] === "boolean");
}

function loadBindings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && actions.every(({ id }) => validBinding(saved[id]))) return saved;
  } catch { }
  return defaults();
}

function eventBinding(event) {
  return {
    code: event.code,
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.ctrlKey ? { ctrl: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
    ...(event.metaKey ? { meta: true } : {}),
  };
}

function sameBinding(left, right) {
  return left.code === right.code && Boolean(left.shift) === Boolean(right.shift) &&
    Boolean(left.ctrl) === Boolean(right.ctrl) && Boolean(left.alt) === Boolean(right.alt) &&
    Boolean(left.meta) === Boolean(right.meta);
}

function matchesEvent(binding, event) {
  return binding.code === event.code && Boolean(binding.shift) === event.shiftKey &&
    Boolean(binding.ctrl) === event.ctrlKey && Boolean(binding.alt) === event.altKey &&
    Boolean(binding.meta) === event.metaKey;
}

function keyLabel(binding) {
  const code = binding.code;
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) :
    ({ ArrowUp: "↑", ArrowRight: "→", ArrowDown: "↓", ArrowLeft: "←", Backspace: "Backspace", Enter: "Enter", Home: "Home", Space: "Space" })[code] || code;
  return [binding.ctrl && "Ctrl", binding.alt && "Alt", binding.shift && "Shift", binding.meta && "⌘", key].filter(Boolean).join(" + ");
}

export function setupKeyboardBindings(onAction) {
  let bindings = loadBindings(), capturing = null;
  const activeActions = new Map();
  const grid = document.querySelector("#key-bindings");
  const summary = document.querySelector("#keyboard-summary");

  function saveAndRender() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    grid.replaceChildren();
    for (const action of actions) {
      const row = document.createElement("div"); row.className = "key-binding";
      const label = document.createElement("span"); label.textContent = action.label;
      const button = document.createElement("button");
      button.type = "button"; button.textContent = capturing === action.id ? "キーを押す…" : keyLabel(bindings[action.id]);
      button.classList.toggle("capturing", capturing === action.id);
      button.onclick = () => { capturing = action.id; saveAndRender(); };
      row.append(label, button); grid.append(row);
    }
    summary.textContent = "左スティック WASD / 十字 Shift+WASD / 右スティック 方向キー / Enterで操作権取得";
  }

  document.querySelector("#reset-key-bindings").onclick = () => { capturing = null; bindings = defaults(); saveAndRender(); };
  saveAndRender();

  return (event, pressed) => {
    if (pressed && capturing) {
      event.preventDefault();
      if (event.code === "Escape") { capturing = null; saveAndRender(); return true; }
      if (modifiers.has(event.code)) return true;
      const targetId = capturing, previousBinding = bindings[targetId], nextBinding = eventBinding(event);
      const duplicate = actions.find(({ id }) => id !== targetId && sameBinding(bindings[id], nextBinding));
      if (duplicate) bindings[duplicate.id] = previousBinding;
      bindings[targetId] = nextBinding; capturing = null; saveAndRender(); return true;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return false;
    let action;
    if (pressed) {
      action = actions.find(({ id }) => matchesEvent(bindings[id], event));
      if (action) activeActions.set(event.code, action);
    } else {
      action = activeActions.get(event.code);
      activeActions.delete(event.code);
    }
    if (!action) return false;
    event.preventDefault(); onAction(action, pressed); return true;
  };
}
