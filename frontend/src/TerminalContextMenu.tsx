import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Search,
  SquareDashed,
  Trash2,
} from "lucide-react";

export type TerminalAction =
  "copy" | "paste" | "selectAll" | "copyAll" | "search" | "clear";

export default function TerminalContextMenu({
  x,
  y,
  hasSelection,
  connected,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  hasSelection: boolean;
  connected: boolean;
  onAction: (action: TerminalAction) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const items = [
    {
      action: "copy",
      label: "复制",
      icon: Copy,
      shortcut: mac ? "⌘ C" : "Ctrl C",
      disabled: !hasSelection,
    },
    {
      action: "paste",
      label: "粘贴",
      icon: ClipboardPaste,
      shortcut: mac ? "⌘ V" : "Ctrl V",
      disabled: !connected,
    },
    {
      action: "selectAll",
      label: "全选",
      icon: SquareDashed,
      shortcut: mac ? "⌘ A" : "Ctrl Shift A",
    },
    { action: "copyAll", label: "复制全部", icon: CopyPlus },
    {
      action: "search",
      label: "查找",
      icon: Search,
      shortcut: mac ? "⌘ Shift F" : "Ctrl Shift F",
    },
    { action: "clear", label: "清屏", icon: Trash2 },
  ] as const;

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="终端操作"
      className="terminal-context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // Keep menu navigation and typeahead out of the remote shell.
        e.stopPropagation();
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const buttons = [
          ...ref.current!.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (index + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }}
    >
      {items.map(({ action, label, icon: Icon, ...item }) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          disabled={"disabled" in item && item.disabled}
          onClick={() => onAction(action)}
        >
          <Icon size={15} aria-hidden="true" />
          <span>{label}</span>
          {"shortcut" in item && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
