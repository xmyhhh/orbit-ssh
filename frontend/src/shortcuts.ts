import type { ShortcutBinding, WindowShortcuts } from "./types";

const binding = (
  code: string,
  modifiers: Partial<Omit<ShortcutBinding, "code">> = {},
): ShortcutBinding => ({
  code,
  primary: false,
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  ...modifiers,
});

export const defaultShortcuts: WindowShortcuts = {
  closeSession: binding("KeyW", { primary: true }),
  newTerminal: binding("KeyT", { primary: true, shift: true }),
  nextSession: binding("Tab", { ctrl: true }),
  previousSession: binding("Tab", { ctrl: true, shift: true }),
  switchSession: binding("Digit", { primary: true }),
};

export const reservedShortcuts = [
  binding("KeyK", { primary: true }),
  binding("KeyT", { primary: true }),
  binding("KeyF", { primary: true, shift: true }),
  binding("KeyV", { primary: true, shift: true }),
  ...[
    "Equal",
    "Minus",
    "Digit0",
    "NumpadAdd",
    "NumpadSubtract",
    "Numpad0",
  ].flatMap((code) => [
    binding(code, { primary: true }),
    binding(code, { primary: true, shift: true }),
  ]),
];

export function usesMacShortcuts(platform: string) {
  return platform
    ? platform === "darwin"
    : /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function resolvedModifiers(shortcut: ShortcutBinding, platform: string) {
  const mac = usesMacShortcuts(platform);
  return {
    ctrl: shortcut.ctrl || (shortcut.primary && !mac),
    meta: shortcut.meta || (shortcut.primary && mac),
    alt: shortcut.alt,
    shift: shortcut.shift,
  };
}

export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: ShortcutBinding,
  platform: string,
) {
  const keyMatches =
    shortcut.code === "Digit"
      ? /^Digit[1-9]$/.test(event.code)
      : event.code === shortcut.code;
  if (!keyMatches) return false;
  const modifiers = resolvedModifiers(shortcut, platform);
  return (
    event.ctrlKey === modifiers.ctrl &&
    event.metaKey === modifiers.meta &&
    event.altKey === modifiers.alt &&
    event.shiftKey === modifiers.shift
  );
}

export function captureShortcut(
  event: KeyboardEvent,
  platform: string,
  code = event.code,
): ShortcutBinding | null {
  if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return null;
  if (!(event.ctrlKey || event.metaKey || event.altKey)) return null;
  const mac = usesMacShortcuts(platform);
  return binding(code, {
    primary: mac ? event.metaKey : event.ctrlKey,
    ctrl: mac && event.ctrlKey,
    meta: !mac && event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
}

export function sameShortcut(
  first: ShortcutBinding,
  second: ShortcutBinding,
  platform: string,
) {
  const sameCode =
    first.code === second.code ||
    (first.code === "Digit" && /^Digit[1-9]$/.test(second.code)) ||
    (second.code === "Digit" && /^Digit[1-9]$/.test(first.code));
  if (!sameCode) return false;
  const firstModifiers = resolvedModifiers(first, platform);
  const secondModifiers = resolvedModifiers(second, platform);
  return (
    firstModifiers.ctrl === secondModifiers.ctrl &&
    firstModifiers.meta === secondModifiers.meta &&
    firstModifiers.alt === secondModifiers.alt &&
    firstModifiers.shift === secondModifiers.shift
  );
}

function keyName(code: string) {
  if (code === "Digit") return "1-9";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const names: Record<string, string> = {
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    Backspace: "Backspace",
    Delete: "Delete",
    Enter: "Enter",
    Equal: "+",
    Escape: "Esc",
    Minus: "-",
    Numpad0: "Num 0",
    NumpadAdd: "Num +",
    NumpadSubtract: "Num -",
    Space: "Space",
    Tab: "Tab",
  };
  return names[code] ?? code;
}

export function formatShortcut(shortcut: ShortcutBinding, platform: string) {
  const mac = usesMacShortcuts(platform);
  const keys = [
    shortcut.primary ? (mac ? "⌘" : "Ctrl") : "",
    shortcut.ctrl ? (mac ? "⌃" : "Ctrl") : "",
    shortcut.meta ? (mac ? "⌘" : "Meta") : "",
    shortcut.alt ? (mac ? "⌥" : "Alt") : "",
    shortcut.shift ? (mac ? "⇧" : "Shift") : "",
    keyName(shortcut.code),
  ].filter(Boolean);
  return keys.join(" + ");
}
