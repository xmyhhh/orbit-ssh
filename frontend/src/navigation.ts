import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type Page = "hosts" | "local" | "wsl" | "history";

export const pageNames: Record<Page, string> = {
  hosts: "远程主机",
  local: "本地 Shell",
  wsl: "WSL",
  history: "终端历史",
};

export function moveTabFocus(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    (e.target as HTMLElement).getAttribute("role") !== "tab" ||
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  )
    return;
  e.preventDefault();
  const tabs = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const index = tabs.indexOf(e.target as HTMLButtonElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next]?.focus();
}
