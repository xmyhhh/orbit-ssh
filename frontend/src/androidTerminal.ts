import type { Terminal } from "@xterm/xterm";
import { androidCall } from "./android";
import { listen } from "./bridge";

interface TouchOptions {
  sessionID: string;
  active: () => boolean;
  connected: () => boolean;
  fit: () => void;
  zoom: (direction: -1 | 1) => void;
  paste: (text: string) => void;
  error: (message: string) => void;
}

/** Touch selection uses xterm's buffer, and its toolbar is Android ActionMode. */
export function installAndroidTerminalTouch(
  element: HTMLElement,
  term: Terminal,
  options: TouchOptions,
) {
  let holdTimer: number | undefined;
  let origin: { x: number; y: number } | undefined;
  let anchor = { x: 0, y: 0, height: 20, viewportWidth: innerWidth };
  let selectionStart = 0;
  let selectionEnd = 0;
  let selecting = false;
  let moved = false;
  let nativeShown = false;
  let pinch: { distance: number; startSize: number; size: number } | undefined;
  let suppressMouseUntil = 0;
  let disposed = false;

  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  const stop = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const hideActions = () => {
    nativeShown = false;
    term.clearSelection();
    void androidCall("HideTerminalActions", options.sessionID).catch(() => {});
  };
  const showActions = () => {
    if (disposed || !options.active()) return;
    nativeShown = true;
    void androidCall(
      "ShowTerminalActions",
      options.sessionID,
      term.getSelection(),
      anchor,
      options.connected(),
    ).catch(() => {
      if (!disposed) options.error("无法打开系统复制粘贴菜单");
    });
  };
  const cellAt = (x: number, y: number) => {
    const screen = element
      .querySelector(".xterm-screen")
      ?.getBoundingClientRect();
    if (!screen?.width || !screen.height) return;
    const height = screen.height / term.rows;
    let column = Math.max(
      0,
      Math.min(
        term.cols - 1,
        Math.floor((x - screen.left) / (screen.width / term.cols)),
      ),
    );
    const row =
      term.buffer.active.viewportY +
      Math.max(
        0,
        Math.min(term.rows - 1, Math.floor((y - screen.top) / height)),
      );
    const line = term.buffer.active.getLine(row);
    if (!line) return;
    // A touch on the trailing cell of a CJK glyph selects the full character.
    if (column > 0 && line.getCell(column)?.getWidth() === 0) column--;
    anchor = {
      x,
      y: screen.top + (row - term.buffer.active.viewportY) * height,
      height,
      viewportWidth: innerWidth,
    };
    return { column, row, line };
  };
  const selectWord = (x: number, y: number) => {
    const cell = cellAt(x, y);
    if (!cell) return;
    const { column, row, line } = cell;
    const separators = term.options.wordSeparator ?? " ()[]{}'\"";
    const isWord = (index: number) => {
      const value = line.getCell(index);
      if (value?.getWidth() === 0) return true;
      const chars = value?.getChars() ?? "";
      return (
        chars.length > 0 && !/\s/u.test(chars) && !separators.includes(chars)
      );
    };
    let start = column;
    let end = column + Math.max(1, line.getCell(column)?.getWidth() ?? 1);
    if (isWord(column)) {
      while (start > 0 && isWord(start - 1)) start--;
      while (end < term.cols && isWord(end)) end++;
    }
    term.select(start, row, end - start);
    selectionStart = row * term.cols + start;
    selectionEnd = row * term.cols + end;
  };
  const distance = (touches: TouchList) =>
    Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
  const finishPinch = () => {
    if (!pinch) return;
    const change = pinch.size - pinch.startSize;
    pinch = undefined;
    // Preview during the gesture; persist only after both fingers lift.
    for (let i = 0; i < Math.abs(change); i++)
      options.zoom(change > 0 ? 1 : -1);
    suppressMouseUntil = performance.now() + 600;
  };
  const touchStart = (event: TouchEvent) => {
    if (!options.active()) return;
    cancelHold();
    if (event.touches.length >= 2) {
      stop(event);
      hideActions();
      selecting = false;
      if (!pinch) {
        const size = Number(term.options.fontSize) || 14;
        pinch = {
          distance: Math.max(1, distance(event.touches)),
          startSize: size,
          size,
        };
      }
      return;
    }
    if (pinch) return stop(event);
    // xterm scrolls its own viewport. Prevent WebView's long-press selection
    // from taking over this gesture before our native toolbar can open.
    if (event.cancelable) event.preventDefault();
    hideActions();
    moved = false;
    origin = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    holdTimer = window.setTimeout(() => {
      if (!origin || !options.active()) return;
      selectWord(origin.x, origin.y);
      selecting = true;
      suppressMouseUntil = performance.now() + 600;
    }, 450);
  };
  const touchMove = (event: TouchEvent) => {
    if (pinch) {
      stop(event);
      if (event.touches.length < 2) return;
      const size = Math.max(
        11,
        Math.min(
          22,
          Math.round(
            (pinch.startSize * distance(event.touches)) / pinch.distance,
          ),
        ),
      );
      if (size !== pinch.size) {
        pinch.size = size;
        term.options.fontSize = size;
        options.fit();
      }
    } else if (selecting) {
      stop(event);
      const cell = cellAt(event.touches[0].clientX, event.touches[0].clientY);
      if (!cell) return;
      const point = cell.row * term.cols + cell.column;
      const start = Math.min(selectionStart, point);
      const end = Math.max(
        selectionEnd,
        point + Math.max(1, cell.line.getCell(cell.column)?.getWidth() ?? 1),
      );
      term.select(
        start % term.cols,
        Math.floor(start / term.cols),
        end - start,
      );
    } else if (
      origin &&
      Math.hypot(
        event.touches[0].clientX - origin.x,
        event.touches[0].clientY - origin.y,
      ) > 8
    ) {
      moved = true;
      cancelHold();
    }
  };
  const touchEnd = (event: TouchEvent) => {
    cancelHold();
    if (pinch) {
      stop(event);
      if (!event.touches.length) finishPinch();
    } else if (selecting) {
      stop(event);
      selecting = false;
      suppressMouseUntil = performance.now() + 600;
      showActions();
    } else if (origin && !moved && options.active()) {
      term.focus();
    }
    if (!event.touches.length) origin = undefined;
  };
  const touchCancel = () => {
    cancelHold();
    origin = undefined;
    selecting = false;
    finishPinch();
  };
  const contextMenu = (event: MouseEvent) => {
    stop(event);
    cancelHold();
    if (pinch || performance.now() < suppressMouseUntil || !options.active())
      return;
    if (!term.hasSelection()) selectWord(event.clientX, event.clientY);
    showActions();
  };
  const suppressMouse = (event: MouseEvent) => {
    if (pinch || selecting || performance.now() < suppressMouseUntil)
      stop(event);
  };
  const selection = term.onSelectionChange(() => {
    if (nativeShown) showActions();
  });
  const offActions = listen("android:terminalAction", (id, action, text) => {
    if (id !== options.sessionID) return;
    if (action === "dismiss") {
      nativeShown = false;
      term.clearSelection();
    } else if (options.active() && action === "selectAll") {
      term.selectAll();
    } else if (options.active() && options.connected() && action === "paste") {
      options.paste(String(text ?? ""));
    }
  });
  element.addEventListener("touchstart", touchStart, {
    capture: true,
    passive: false,
  });
  element.addEventListener("touchmove", touchMove, {
    capture: true,
    passive: false,
  });
  element.addEventListener("touchend", touchEnd, {
    capture: true,
    passive: false,
  });
  element.addEventListener("touchcancel", touchCancel, true);
  element.addEventListener("contextmenu", contextMenu, true);
  element.addEventListener("mousedown", suppressMouse, true);
  element.addEventListener("click", suppressMouse, true);
  return () => {
    disposed = true;
    cancelHold();
    element.removeEventListener("touchstart", touchStart, true);
    element.removeEventListener("touchmove", touchMove, true);
    element.removeEventListener("touchend", touchEnd, true);
    element.removeEventListener("touchcancel", touchCancel, true);
    element.removeEventListener("contextmenu", contextMenu, true);
    element.removeEventListener("mousedown", suppressMouse, true);
    element.removeEventListener("click", suppressMouse, true);
    selection.dispose();
    offActions();
    hideActions();
  };
}
