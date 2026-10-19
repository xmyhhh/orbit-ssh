import assert from "node:assert/strict";
import test from "node:test";
import {
  createSplitLayout,
  equalizeSplitLayout,
  insertSplitPane,
  paneDropPlacement,
  removeSplitPane,
  replaceSplitPane,
  splitLayoutGeometry,
  splitLayoutIds,
  updateSplitRatio,
} from "../src/splitLayout.ts";

test("switching a tab replaces only the focused pane and preserves resized dividers", () => {
  const original = updateSplitRatio(
    createSplitLayout(["a", "b", "c"], "grid"),
    "1",
    0.7,
  );
  const before = splitLayoutGeometry(original);
  const replaced = replaceSplitPane(original, "b", "d");
  assert.deepEqual(splitLayoutIds(replaced), ["a", "d", "c"]);
  assert.deepEqual(splitLayoutGeometry(replaced).dividers, before.dividers);
  assert.deepEqual(
    splitLayoutGeometry(replaced).panes.map(({ id, ...rect }) => rect),
    before.panes.map(({ id, ...rect }) => rect),
  );
  assert.deepEqual(splitLayoutIds(original), ["a", "b", "c"]);
});

test("dropping a visible terminal into the center swaps panes without losing either session", () => {
  const original = createSplitLayout(["a", "b", "c", "d"], "grid");
  const swapped = replaceSplitPane(original, "a", "d");
  assert.deepEqual(splitLayoutIds(swapped), ["d", "b", "c", "a"]);
  assert.deepEqual(
    splitLayoutGeometry(swapped).dividers,
    splitLayoutGeometry(original).dividers,
  );
  assert.equal(replaceSplitPane(original, "missing", "d"), original);
});

test("moving panes to every edge and removing panes keeps all remaining terminals exactly once", () => {
  for (const direction of ["left", "right", "top", "bottom"]) {
    const original = createSplitLayout(["a", "b", "c", "d"], "grid");
    const moved = insertSplitPane(
      removeSplitPane(original, "c"),
      "a",
      "c",
      direction,
    );
    assert.deepEqual(splitLayoutIds(moved).sort(), ["a", "b", "c", "d"]);
    const geometry = splitLayoutGeometry(moved).panes;
    const a = geometry.find((pane) => pane.id === "a");
    const c = geometry.find((pane) => pane.id === "c");
    if (direction === "left") assert.ok(c.left < a.left);
    if (direction === "right") assert.ok(c.left > a.left);
    if (direction === "top") assert.ok(c.top < a.top);
    if (direction === "bottom") assert.ok(c.top > a.top);
    const removed = removeSplitPane(moved, "a");
    assert.deepEqual(splitLayoutIds(removed).sort(), ["b", "c", "d"]);
  }
  const original = createSplitLayout(["a", "b"], "columns");
  assert.equal(insertSplitPane(original, "a", "b", "left"), original);
  assert.equal(insertSplitPane(original, "a", "a", "left"), original);
  assert.equal(removeSplitPane(removeSplitPane(original, "a"), "b"), null);
});

test("presets cover the whole workspace without overlaps for two, three and four terminals", () => {
  for (const preset of ["columns", "rows", "grid"]) {
    for (const count of [2, 3, 4]) {
      const ids = Array.from({ length: count }, (_, i) => String(i));
      const { panes } = splitLayoutGeometry(createSplitLayout(ids, preset));
      assert.equal(panes.length, count);
      assert.ok(
        Math.abs(
          panes.reduce((sum, pane) => sum + pane.width * pane.height, 0) - 1,
        ) < 1e-10,
      );
      for (const a of panes) {
        assert.ok(a.width > 0 && a.height > 0 && a.left >= 0 && a.top >= 0);
        assert.ok(a.left + a.width <= 1.00001 && a.top + a.height <= 1.00001);
        for (const b of panes) {
          if (a === b) continue;
          const overlapWidth =
            Math.min(a.left + a.width, b.left + b.width) -
            Math.max(a.left, b.left);
          const overlapHeight =
            Math.min(a.top + a.height, b.top + b.height) -
            Math.max(a.top, b.top);
          assert.ok(overlapWidth < 1e-10 || overlapHeight < 1e-10);
        }
      }
      if (preset !== "grid")
        for (const pane of panes)
          assert.ok(Math.abs(pane.width * pane.height - 1 / count) < 1e-10);
    }
  }
});

test("equalizing restores equal thirds and keeps custom split directions", () => {
  const original = createSplitLayout(["a", "b", "c"], "columns");
  const resized = updateSplitRatio(
    updateSplitRatio(original, "", 0.4),
    "0",
    0.8,
  );
  const restored = equalizeSplitLayout(resized);
  for (const pane of splitLayoutGeometry(restored).panes)
    assert.ok(Math.abs(pane.width - 1 / 3) < 1e-10);
  assert.deepEqual(splitLayoutIds(restored), ["a", "b", "c"]);
});

test("only edges split; centers replace, and compact windows only use top and bottom", () => {
  assert.equal(paneDropPlacement(10, 250, 800, 500), "left");
  assert.equal(paneDropPlacement(790, 250, 800, 500), "right");
  assert.equal(paneDropPlacement(400, 10, 800, 500), "top");
  assert.equal(paneDropPlacement(400, 490, 800, 500), "bottom");
  assert.equal(paneDropPlacement(400, 250, 800, 500), "center");
  assert.equal(paneDropPlacement(10, 250, 390, 500, true), "center");
  assert.equal(paneDropPlacement(10, 490, 390, 500, true), "bottom");
  assert.equal(paneDropPlacement(0, 0, 0, 0), "center");
});
