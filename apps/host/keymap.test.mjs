import assert from "node:assert/strict";
import test from "node:test";
import { defaultKeyboardBindings } from "./public/keymap.js";

test("uses the requested controller keyboard defaults", () => {
  const bindings = defaultKeyboardBindings();
  assert.deepEqual(
    Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, `${binding.shift ? "Shift+" : ""}${binding.code}`])),
    {
      "lstick-up": "KeyW", "lstick-left": "KeyA", "lstick-down": "KeyS", "lstick-right": "KeyD",
      up: "Shift+KeyW", left: "Shift+KeyA", down: "Shift+KeyS", right: "Shift+KeyD",
      "rstick-up": "ArrowUp", "rstick-left": "ArrowLeft", "rstick-down": "ArrowDown", "rstick-right": "ArrowRight",
      a: "KeyL", b: "KeyK", x: "KeyI", y: "KeyJ",
      l: "KeyQ", zl: "KeyE", zr: "KeyU", r: "KeyO",
      minus: "KeyV", plus: "KeyN", home: "KeyB", capture: "Space",
      lstick: "KeyX", rstick: "KeyM", claim: "Enter",
    },
  );
});
