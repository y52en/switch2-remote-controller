import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const here = new URL("./public/", import.meta.url);

test("renders three accessible controller selectors and assignment controls", async () => {
  const html = await readFile(new URL("index.html", here), "utf8");
  const slots = [...html.matchAll(/data-controller-slot="(\d)"/g)].map((match) => Number(match[1]));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(slots, [0, 1, 2]);
  assert.equal(new Set(ids).size, ids.length, "interactive status targets must have unique IDs");
  assert.match(html, /id="controller-target"[^>]*role="status"/);
  assert.match(html, /参加者を3台のコントローラーへ個別に割り当て/);
  assert.match(html, /<details id="device-diagnostics"/);
  assert.doesNotMatch(html, /maximum-scale|user-scalable/);
});

test("keeps mobile slot selection and remote ownership visually distinct", async () => {
  const css = await readFile(new URL("style.css", here), "utf8");
  assert.match(css, /\.slot-card\.selected/);
  assert.match(css, /\.slot-card\.assigned/);
  assert.match(css, /\.slot-card\.selected\.assigned/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /#join-session\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.controller-slots \{ grid-template-columns: 1fr; \}/);
});
