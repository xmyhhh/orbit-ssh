import { useState } from "react";
import type { DragEvent } from "react";
import { Columns2, Replace, Rows2 } from "lucide-react";
import { paneDropPlacement, type PanePlacement } from "./splitLayout";

interface Props {
  sourceId: string;
  targetId: string;
  swapping: boolean;
  canSplit: boolean;
  compact: boolean;
  onPlace: (id: string, targetId: string, placement: PanePlacement) => void;
  onFinish: () => void;
}

const labels: Record<PanePlacement, string> = {
  left: "在左侧分屏",
  right: "在右侧分屏",
  top: "在上方分屏",
  bottom: "在下方分屏",
  center: "在此显示",
};

export default function TerminalDropTarget({
  sourceId,
  targetId,
  swapping,
  canSplit,
  compact,
  onPlace,
  onFinish,
}: Props) {
  const [placement, setPlacement] = useState<PanePlacement | null>(null);
  function position(event: DragEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return canSplit
      ? paneDropPlacement(
          event.clientX - rect.left,
          event.clientY - rect.top,
          rect.width,
          rect.height,
          compact,
        )
      : "center";
  }
  const Icon =
    placement === "center"
      ? Replace
      : placement === "top" || placement === "bottom"
        ? Rows2
        : Columns2;
  return (
    <div
      className="terminal-drop-target"
      aria-label="拖到边缘分屏，拖到中间替换终端"
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setPlacement(position(event));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setPlacement(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (
          event.dataTransfer.getData("application/x-orbit-terminal-session") ===
          sourceId
        )
          onPlace(sourceId, targetId, position(event));
        onFinish();
      }}
    >
      {placement && (
        <div className={`terminal-drop-preview placement-${placement}`}>
          <span>
            <Icon size={15} />
            {placement === "center" && swapping
              ? "交换终端"
              : labels[placement]}
          </span>
        </div>
      )}
    </div>
  );
}
