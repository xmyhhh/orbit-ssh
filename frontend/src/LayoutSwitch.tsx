import { Grid2X2, LayoutList } from "lucide-react";
import type { Preferences } from "./types";

export default function LayoutSwitch({
  layout,
  onChange,
  label,
}: {
  layout: Preferences["hostLayout"];
  onChange: (layout: Preferences["hostLayout"]) => void;
  label: string;
}) {
  return (
    <div className="layout-switch" role="group" aria-label={label}>
      <button
        className={layout === "grid" ? "selected" : ""}
        aria-label="卡片视图"
        aria-pressed={layout === "grid"}
        title="卡片视图"
        onClick={() => onChange("grid")}
      >
        <Grid2X2 size={15} aria-hidden="true" />
      </button>
      <button
        className={layout === "list" ? "selected" : ""}
        aria-label="紧凑列表视图"
        aria-pressed={layout === "list"}
        title="紧凑列表视图"
        onClick={() => onChange("list")}
      >
        <LayoutList size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
