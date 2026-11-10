import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(
  new URL("../src/styles/dialogs.css", import.meta.url),
  "utf8",
);
const dialog = readFileSync(
  new URL("../src/dialogs/PreferencesDialog.tsx", import.meta.url),
  "utf8",
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

test("switch tracks keep their width next to long setting hints", () => {
  const track = rule(".switch");
  // A flex item shrinks by default; the longest hint in the integration tab
  // used to squeeze the 33px track to 17px and the knob spilled out to the
  // right. The track must never shrink.
  assert.match(track, /flex:\s*0 0 auto/);
  assert.match(track, /width:\s*33px/);
  assert.match(track, /min-width:\s*33px/);
  // The knob is positioned by a fixed 14px translate, so it must not resize.
  assert.match(rule(".switch > span"), /flex:\s*0 0 auto/);
  // The copy yields instead, so the hint wraps rather than squeezing the track.
  assert.match(rule(".setting-row > div"), /min-width:\s*0/);
});

test("every preferences switch shares the same track and role", () => {
  // Each switch is a <button role="switch"> with className={`switch ...`}.
  const buttons = dialog.split("className={`switch ").slice(1);
  assert.ok(buttons.length >= 7, `unexpected switch count: ${buttons.length}`);
  for (const button of buttons) {
    const head = button.slice(0, button.indexOf(">"));
    assert.match(head, /role="switch"/);
    assert.match(head, /aria-checked=/);
    assert.match(head, /aria-label=/);
  }
  // No switch may bypass the class that carries the fixed track size.
  assert.doesNotMatch(dialog, /className="switch"/);
});
