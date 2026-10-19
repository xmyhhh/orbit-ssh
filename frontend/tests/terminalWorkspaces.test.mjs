import assert from "node:assert/strict";
import test from "node:test";
import {
  createSplitLayout,
  removeSplitPane,
  splitLayoutIds,
  updateSplitRatio,
} from "../src/splitLayout.ts";
import {
  pruneWorkspaces,
  saveWorkspaceLayout,
  terminalTabs,
  workspaceForSession,
} from "../src/terminalWorkspaces.ts";

test("a split is one tab and selecting an independent terminal preserves its layout and focus", () => {
  const layout = updateSplitRatio(
    createSplitLayout(["1", "2"], "columns"),
    "",
    0.68,
  );
  const groups = saveWorkspaceLayout([], layout, "2", "split-12");
  const tabs = terminalTabs(["1", "2", "3"], groups);
  assert.deepEqual(
    tabs.map((tab) => tab.sessionIds),
    [["1", "2"], ["3"]],
  );
  assert.equal(workspaceForSession(groups, "3"), undefined);
  assert.equal(workspaceForSession(groups, tabs[0].activeId).layout, layout);
  assert.equal(tabs[0].activeId, "2");
});

test("multiple split tabs retain independent ratios when a pane moves between them", () => {
  const first = updateSplitRatio(
    createSplitLayout(["1", "2", "5"], "rows"),
    "",
    0.7,
  );
  const second = updateSplitRatio(
    createSplitLayout(["3", "4"], "columns"),
    "",
    0.3,
  );
  let groups = saveWorkspaceLayout([], first, "2", "first");
  groups = saveWorkspaceLayout(groups, second, "4", "second");
  groups = saveWorkspaceLayout(
    groups,
    createSplitLayout(["3", "4", "2"], "columns"),
    "2",
    "second",
  );
  assert.deepEqual(
    splitLayoutIds(groups.find((group) => group.id === "first").layout),
    ["1", "5"],
  );
  assert.equal(groups.find((group) => group.id === "first").layout.ratio, 0.7);
  const all = terminalTabs(["1", "2", "3", "4", "5"], groups).flatMap(
    (tab) => tab.sessionIds,
  );
  assert.deepEqual(all.sort(), ["1", "2", "3", "4", "5"]);
  assert.equal(new Set(all).size, all.length);
});

test("replacing, detaching and closing panes restores standalone tabs without losing sessions", () => {
  let groups = saveWorkspaceLayout(
    [],
    createSplitLayout(["1", "2", "3"], "grid"),
    "2",
    "first",
  );
  groups = saveWorkspaceLayout(
    groups,
    removeSplitPane(groups[0].layout, "2"),
    "1",
    "first",
  );
  assert.deepEqual(
    terminalTabs(["1", "2", "3"], groups).map((tab) => tab.sessionIds),
    [["1", "3"], ["2"]],
  );
  assert.equal(pruneWorkspaces(groups, new Set(["1", "2", "3"])), groups);
  groups = pruneWorkspaces(groups, new Set(["1", "2"]));
  assert.deepEqual(
    terminalTabs(["1", "2"], groups).map((tab) => tab.sessionIds),
    [["1"], ["2"]],
  );
  groups = saveWorkspaceLayout(
    groups,
    createSplitLayout(["1", "2"], "columns"),
    "2",
    "new",
  );
  groups = saveWorkspaceLayout(groups, null, "2", "new");
  assert.deepEqual(
    terminalTabs(["1", "2"], groups).map((tab) => tab.sessionIds),
    [["1"], ["2"]],
  );
});
