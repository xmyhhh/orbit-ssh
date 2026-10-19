export type SplitDirection = "left" | "right" | "top" | "bottom";
export type SplitAxis = "x" | "y";
export type SplitPreset = "columns" | "rows" | "grid";
export type PanePlacement = SplitDirection | "center";

export type SplitLayout =
  | string
  | {
      kind: "split";
      axis: SplitAxis;
      ratio: number;
      first: SplitLayout;
      second: SplitLayout;
    };

export interface PaneGeometry {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DividerGeometry {
  path: string;
  axis: SplitAxis;
  ratio: number;
  left: number;
  top: number;
  width: number;
  height: number;
  parentWidth: number;
  parentHeight: number;
  resizable?: boolean;
}

export function splitLayoutIds(layout: SplitLayout | null): string[] {
  if (!layout) return [];
  if (typeof layout === "string") return [layout];
  return [...splitLayoutIds(layout.first), ...splitLayoutIds(layout.second)];
}

export function insertSplitPane(
  layout: SplitLayout,
  targetId: string,
  id: string,
  direction: SplitDirection,
): SplitLayout {
  if (id === targetId || splitLayoutIds(layout).includes(id)) return layout;
  return insert(layout);

  function insert(node: SplitLayout): SplitLayout {
    if (node === targetId) return pair(targetId, id, direction);
    if (typeof node === "string") return node;
    const first = insert(node.first);
    if (first !== node.first) return { ...node, first };
    const second = insert(node.second);
    return second === node.second ? node : { ...node, second };
  }
}

// Replacing a focused pane keeps every divider in place. Dropping a visible
// terminal onto another pane swaps the two terminals instead of duplicating it.
export function replaceSplitPane(
  layout: SplitLayout,
  targetId: string,
  id: string,
): SplitLayout {
  if (targetId === id || !splitLayoutIds(layout).includes(targetId))
    return layout;
  const swap = splitLayoutIds(layout).includes(id);
  function replace(node: SplitLayout): SplitLayout {
    if (typeof node === "string") {
      if (node === targetId) return id;
      return swap && node === id ? targetId : node;
    }
    const first = replace(node.first);
    const second = replace(node.second);
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  }
  return replace(layout);
}

export function createSplitLayout(
  ids: string[],
  preset: SplitPreset,
): SplitLayout | null {
  const unique = [...new Set(ids)].slice(0, 4);
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0];
  if (preset === "grid" && unique.length > 2) {
    if (unique.length === 3)
      return {
        kind: "split",
        axis: "x",
        ratio: 0.5,
        first: unique[0],
        second: pair(unique[1], unique[2], "bottom"),
      };
    return {
      kind: "split",
      axis: "y",
      ratio: 0.5,
      first: pair(unique[0], unique[1], "right"),
      second: pair(unique[2], unique[3], "right"),
    };
  }
  const axis = preset === "rows" ? "y" : "x";
  function distribute(items: string[]): SplitLayout {
    if (items.length === 1) return items[0];
    // A balanced tree allows equal thirds without the old 20% ratio clamp.
    const middle = Math.ceil(items.length / 2);
    return {
      kind: "split",
      axis,
      ratio: middle / items.length,
      first: distribute(items.slice(0, middle)),
      second: distribute(items.slice(middle)),
    };
  }
  return distribute(unique);
}

export function splitLayoutPreset(
  layout: SplitLayout | null,
): SplitPreset | null {
  if (!layout || typeof layout === "string") return null;
  function allOnAxis(node: SplitLayout, axis: SplitAxis): boolean {
    return (
      typeof node === "string" ||
      (node.axis === axis &&
        allOnAxis(node.first, axis) &&
        allOnAxis(node.second, axis))
    );
  }
  if (allOnAxis(layout, "x")) return "columns";
  if (allOnAxis(layout, "y")) return "rows";
  const ids = splitLayoutIds(layout);
  const grid = createSplitLayout(ids, "grid");
  function sameShape(a: SplitLayout, b: SplitLayout): boolean {
    if (typeof a === "string" || typeof b === "string")
      return typeof a === typeof b;
    return (
      a.axis === b.axis &&
      sameShape(a.first, b.first) &&
      sameShape(a.second, b.second)
    );
  }
  return grid && sameShape(layout, grid) ? "grid" : null;
}

export function equalizeSplitLayout(layout: SplitLayout): SplitLayout {
  if (typeof layout === "string") return layout;
  function weight(node: SplitLayout, axis: SplitAxis): number {
    if (typeof node === "string") return 1;
    const first = weight(node.first, axis);
    const second = weight(node.second, axis);
    return node.axis === axis ? first + second : Math.max(first, second);
  }
  const first = weight(layout.first, layout.axis);
  const second = weight(layout.second, layout.axis);
  return {
    ...layout,
    ratio: first / (first + second),
    first: equalizeSplitLayout(layout.first),
    second: equalizeSplitLayout(layout.second),
  };
}

export function paneDropPlacement(
  x: number,
  y: number,
  width: number,
  height: number,
  compact = false,
): PanePlacement {
  if (width <= 0 || height <= 0) return "center";
  const edges: [SplitDirection, number][] = compact
    ? [
        ["top", y / height],
        ["bottom", 1 - y / height],
      ]
    : [
        ["left", x / width],
        ["right", 1 - x / width],
        ["top", y / height],
        ["bottom", 1 - y / height],
      ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][1] <= 0.25 ? edges[0][0] : "center";
}

export function removeSplitPane(
  layout: SplitLayout,
  id: string,
): SplitLayout | null {
  if (layout === id) return null;
  if (typeof layout === "string") return layout;
  const first = removeSplitPane(layout.first, id);
  const second = removeSplitPane(layout.second, id);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function updateSplitRatio(
  layout: SplitLayout,
  path: string,
  ratio: number,
): SplitLayout {
  if (typeof layout === "string") return layout;
  if (path.length === 0)
    return { ...layout, ratio: Math.max(0.2, Math.min(0.8, ratio)) };
  const child = path[0] === "0" ? "first" : "second";
  return {
    ...layout,
    [child]: updateSplitRatio(layout[child], path.slice(1), ratio),
  };
}

export function splitLayoutGeometry(
  layout: SplitLayout | null,
  compact = false,
): {
  panes: PaneGeometry[];
  dividers: DividerGeometry[];
} {
  const panes: PaneGeometry[] = [];
  const dividers: DividerGeometry[] = [];
  const ids = splitLayoutIds(layout);

  if (compact && ids.length > 1) {
    const paneHeight = 1 / ids.length;
    ids.forEach((id, index) => {
      panes.push({
        id,
        left: 0,
        top: paneHeight * index,
        width: 1,
        height: paneHeight,
      });
      if (index < ids.length - 1)
        dividers.push({
          path: `stack-${index}`,
          axis: "y",
          ratio: 0.5,
          left: 0,
          top: paneHeight * (index + 1),
          width: 1,
          height: 0,
          parentWidth: 1,
          parentHeight: 1,
          resizable: false,
        });
    });
    return { panes, dividers };
  }

  function visit(
    node: SplitLayout,
    left: number,
    top: number,
    width: number,
    height: number,
    path: string,
  ) {
    if (typeof node === "string") {
      panes.push({ id: node, left, top, width, height });
      return;
    }

    const ratio = Math.max(0.2, Math.min(0.8, node.ratio));
    if (node.axis === "x") {
      const splitX = left + width * ratio;
      dividers.push({
        path,
        axis: node.axis,
        ratio,
        left: splitX,
        top,
        width: 0,
        height,
        parentWidth: width,
        parentHeight: height,
      });
      visit(node.first, left, top, width * ratio, height, `${path}0`);
      visit(node.second, splitX, top, width * (1 - ratio), height, `${path}1`);
      return;
    }

    const splitY = top + height * ratio;
    dividers.push({
      path,
      axis: node.axis,
      ratio,
      left,
      top: splitY,
      width,
      height: 0,
      parentWidth: width,
      parentHeight: height,
    });
    visit(node.first, left, top, width, height * ratio, `${path}0`);
    visit(node.second, left, splitY, width, height * (1 - ratio), `${path}1`);
  }

  if (layout) visit(layout, 0, 0, 1, 1, "");
  return { panes, dividers };
}

function pair(
  targetId: string,
  id: string,
  direction: SplitDirection,
): SplitLayout {
  const axis: SplitAxis =
    direction === "left" || direction === "right" ? "x" : "y";
  const before = direction === "left" || direction === "top";
  return {
    kind: "split",
    axis,
    ratio: 0.5,
    first: before ? id : targetId,
    second: before ? targetId : id,
  };
}
