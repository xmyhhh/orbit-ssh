import { ChevronDown, Columns2 } from "lucide-react";
import type { Session } from "./types";
import TerminalLayoutPicker from "./TerminalLayoutPicker";
import type { TerminalLayoutController } from "./hooks/useTerminalLayout";

export default function TerminalLayoutControl({
  sessions,
  active,
  layout,
  onNewTerminal,
}: {
  sessions: Session[];
  active: string;
  layout: TerminalLayoutController;
  onNewTerminal: () => void;
}) {
  const session = sessions.find((session) => session.id === active);
  return (
    <div className="split-control" ref={layout.splitControlRef}>
      <button
        className={`button toolbar-button split-toggle ${layout.splitMode ? "selected" : ""}`}
        aria-label="终端布局"
        aria-pressed={layout.splitMode}
        aria-expanded={layout.splitPickerOpen}
        aria-haspopup="dialog"
        aria-controls="terminal-layout-picker"
        title="终端布局与分屏"
        disabled={!session || session.status === "connecting"}
        onClick={() => layout.setSplitPickerOpen((open) => !open)}
      >
        <Columns2 size={16} aria-hidden="true" />
        <span>分屏</span>
        {layout.splitMode && (
          <span className="split-count">{layout.splitSessionIds.length}</span>
        )}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {layout.splitPickerOpen && (
        <TerminalLayoutPicker
          sessions={sessions}
          activeId={active}
          selectedIds={layout.splitSelection}
          layout={layout.splitLayout}
          compact={layout.compactSplit}
          onPreset={layout.applySplitPreset}
          onToggle={layout.toggleSplitSession}
          onEqualize={layout.equalizePanes}
          onNewTerminal={() => {
            layout.setSplitPickerOpen(false);
            onNewTerminal();
          }}
        />
      )}
    </div>
  );
}
