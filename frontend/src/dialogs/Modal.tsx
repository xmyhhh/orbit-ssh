import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = requestAnimationFrame(() =>
      (
        (ref.current?.querySelector("input, textarea, select") ??
          ref.current?.querySelector("button")) as HTMLElement | null
      )?.focus(),
    );
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Let an open dropdown dismiss itself before the dialog closes.
        if (document.body.dataset.selectOpen) return;
        // Let CodeMirror dismiss its search panel or completion popup first.
        if (
          (event.target as Element).closest?.(".cm-editor") &&
          ref.current?.querySelector(".cm-panel, .cm-tooltip")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const nodes = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], summary, input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ].filter((n) => n.offsetParent !== null);
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(timer);
      document.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        // A second press can land here after the first click opens the dialog.
        if (e.target === e.currentTarget && e.detail < 2) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-heading"
      >
        <div className="modal-heading">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id="modal-heading">{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭对话框"
            title="关闭"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
