import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pane = readFileSync(new URL("../src/TerminalPane.tsx", import.meta.url), "utf8");
const canvas = readFileSync(new URL("../src/TerminalCanvas.tsx", import.meta.url), "utf8");

// Guard the React lifecycle wiring as well as the browser rendering checks:
// focus must never release the renderer of a still-visible split pane.
test("terminal canvas passes pane visibility independently of input focus", () => {
  assert.match(canvas, /hidden=\{!visible\}/);
  assert.match(canvas, /<TerminalPane[\s\S]*?visible=\{visible\}/);
  assert.doesNotMatch(canvas, /selected=\{active === s\.id\}/);
});

test("visible terminals attach a renderer even when opened without focus", () => {
  assert.match(pane, /if \(latest\.current\.visible\) attachWebglRenderer\(term\)/);
  assert.doesNotMatch(pane, /if \(latest\.current\.active\) attachWebglRenderer\(term\)/);
});

test("renderer lifetime follows visibility, not focus or modal suspension", () => {
  const effect = pane.match(/useEffect\(\(\) => \{\s*if \(!visible\)[\s\S]*?\}, \[visible, session\.id\]\);/)?.[0];
  assert.ok(effect, "renderer effect must depend only on pane visibility and session identity");
  assert.match(effect, /if \(!visible\) \{\s*releaseWebglRenderer\(\);\s*return;/);
  assert.match(effect, /attachWebglRenderer\(term\)/);
  assert.match(effect, /requestFit\.current\(\)/);
  assert.match(effect, /term\.refresh\(0, term\.rows - 1\)/);
  assert.match(effect, /cancelAnimationFrame\(rendererFrame\)/);
  assert.doesNotMatch(effect, /\bactive\b|\bselected\b/);
});
