import {
  removeSplitPane,
  splitLayoutIds,
  type SplitLayout,
} from "./splitLayout.ts";

export interface TerminalWorkspace {
  id: string;
  layout: SplitLayout;
  activeId: string;
}

export interface TerminalTab {
  id: string;
  sessionIds: string[];
  activeId: string;
  layout: SplitLayout | null;
}

export function workspaceForSession(
  workspaces: TerminalWorkspace[],
  id: string,
) {
  return workspaces.find((workspace) =>
    splitLayoutIds(workspace.layout).includes(id),
  );
}

/** A session belongs to at most one tab. Removed panes become ordinary tabs. */
export function saveWorkspaceLayout(
  workspaces: TerminalWorkspace[],
  layout: SplitLayout | null,
  activeId: string,
  workspaceId: string,
): TerminalWorkspace[] {
  const members = splitLayoutIds(layout);
  const next = workspaces.flatMap((workspace) => {
    if (workspace.id === workspaceId) return [];
    let remaining: SplitLayout | null = workspace.layout;
    for (const id of members)
      if (remaining) remaining = removeSplitPane(remaining, id);
    const ids = splitLayoutIds(remaining);
    if (!remaining || ids.length < 2) return [];
    return [
      {
        ...workspace,
        layout: remaining,
        activeId: ids.includes(workspace.activeId)
          ? workspace.activeId
          : ids[0],
      },
    ];
  });
  if (layout && members.length > 1) {
    next.push({
      id: workspaceId,
      layout,
      activeId: members.includes(activeId) ? activeId : members[0],
    });
  }
  return next;
}

export function pruneWorkspaces(
  workspaces: TerminalWorkspace[],
  openIds: ReadonlySet<string>,
) {
  let changed = false;
  const next = workspaces.flatMap((workspace) => {
    let layout: SplitLayout | null = workspace.layout;
    for (const id of splitLayoutIds(layout)) {
      if (!openIds.has(id) && layout) layout = removeSplitPane(layout, id);
    }
    if (layout === workspace.layout) return [workspace];
    changed = true;
    const ids = splitLayoutIds(layout);
    return layout && ids.length > 1
      ? [
          {
            ...workspace,
            layout,
            activeId: ids.includes(workspace.activeId)
              ? workspace.activeId
              : ids[0],
          },
        ]
      : [];
  });
  return changed ? next : workspaces;
}

export function terminalTabs(
  sessionIds: string[],
  workspaces: TerminalWorkspace[],
): TerminalTab[] {
  const seen = new Set<string>();
  return sessionIds.flatMap((id) => {
    if (seen.has(id)) return [];
    const workspace = workspaceForSession(workspaces, id);
    const members = workspace ? splitLayoutIds(workspace.layout) : [id];
    members.forEach((member) => seen.add(member));
    return [
      {
        id: workspace?.id ?? id,
        sessionIds: members,
        activeId: workspace?.activeId ?? id,
        layout: workspace?.layout ?? null,
      },
    ];
  });
}
