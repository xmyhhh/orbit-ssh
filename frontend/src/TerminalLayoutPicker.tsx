import { useEffect, useRef } from "react";
import { Check, GripVertical, Plus, RotateCcw } from "lucide-react";
import type { Session } from "./types";
import {
  createSplitLayout,
  splitLayoutGeometry,
  splitLayoutPreset,
  type SplitLayout,
  type SplitPreset,
} from "./splitLayout";

export function LayoutPreview({
  preset,
  count = 2,
}: {
  preset: SplitPreset | "single";
  count?: number;
}) {
  const layout = createSplitLayout(
    Array.from({ length: preset === "single" ? 1 : count }, (_, i) =>
      String(i),
    ),
    preset === "single" ? "columns" : preset,
  );
  return (
    <span className="layout-preview" aria-hidden="true">
      {splitLayoutGeometry(layout).panes.map((pane) => (
        <i
          key={pane.id}
          style={{
            left: `${pane.left * 100}%`,
            top: `${pane.top * 100}%`,
            width: `${pane.width * 100}%`,
            height: `${pane.height * 100}%`,
          }}
        />
      ))}
    </span>
  );
}

interface Props {
  sessions: Session[];
  activeId: string;
  selectedIds: string[];
  layout: SplitLayout | null;
  compact: boolean;
  onPreset: (preset: SplitPreset | "single") => void;
  onToggle: (id: string) => void;
  onEqualize: () => void;
  onNewTerminal: () => void;
}

export default function TerminalLayoutPicker({
  sessions,
  activeId,
  selectedIds,
  layout,
  compact,
  onPreset,
  onToggle,
  onEqualize,
  onNewTerminal,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const split = selectedIds.length > 1;
  const currentPreset = split
    ? compact
      ? "rows"
      : splitLayoutPreset(layout)
    : "single";
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus();
  }, []);
  return (
    <div
      ref={ref}
      id="terminal-layout-picker"
      className="split-picker"
      role="dialog"
      aria-label="终端布局"
    >
      <div className="split-picker-heading">
        <strong>终端布局</strong>
        <span>{selectedIds.length} / 4 窗格</span>
      </div>
      <div className="split-presets">
        {(
          [
            ["single", "单窗格"],
            ["columns", "左右分屏"],
            ["rows", "上下分屏"],
            ["grid", "网格"],
          ] as const
        ).map(([preset, label]) => (
          <button
            key={preset}
            className="split-preset"
            aria-pressed={currentPreset === preset}
            disabled={
              (compact && (preset === "columns" || preset === "grid")) ||
              (preset === "grid" && sessions.length < 3)
            }
            title={
              compact && (preset === "columns" || preset === "grid")
                ? "加宽窗口后可用"
                : preset === "grid" && sessions.length < 3
                  ? "打开至少 3 个终端后可用"
                  : label
            }
            onClick={() => onPreset(preset)}
          >
            <LayoutPreview preset={preset} count={preset === "grid" ? 4 : 2} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="split-picker-section">
        <span>显示的终端</span>
        <small>
          {compact && split ? "窄窗口自动上下排列" : "最多选择 4 个"}
        </small>
      </div>
      <div className="split-session-options">
        {sessions.map((session) => {
          const checked = selectedIds.includes(session.id);
          const disabled =
            (checked && selectedIds.length === 1) ||
            (!checked && selectedIds.length >= 4);
          return (
            <label
              className={`split-session-option ${checked ? "checked" : ""}`}
              key={session.id}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onToggle(session.id)}
              />
              <span className="split-session-check" aria-hidden="true">
                {checked && <Check size={12} />}
              </span>
              <span
                className={`status-dot ${session.status === "closed" ? "offline" : ""}`}
                aria-hidden="true"
              />
              <span className="split-session-label">
                <strong>
                  {session.host.name}
                  <small>终端 #{session.terminalNumber}</small>
                </strong>
                <small>
                  {session.localShell
                    ? "本地 Shell"
                    : session.wslDistribution
                      ? "WSL"
                      : `${session.host.username}@${session.host.address}`}
                </small>
              </span>
              {session.id === activeId && (
                <span className="split-current-tag">当前</span>
              )}
            </label>
          );
        })}
      </div>
      <div className="split-picker-actions">
        <button onClick={onNewTerminal}>
          <Plus size={14} />
          新建终端
        </button>
        <button disabled={!split || compact} onClick={onEqualize}>
          <RotateCcw size={13} />
          均分窗格
        </button>
      </div>
      <p className="split-picker-hint">
        <GripVertical size={13} />
        拖动标签或窗格标题到边缘，自由分屏
      </p>
    </div>
  );
}
