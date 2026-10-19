import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { paneDropPlacement, type PanePlacement } from "../splitLayout";

interface DropPoint {
  targetId: string;
  placement: PanePlacement;
}

export function useTerminalDrag(options: {
  compact: boolean;
  splitSessionIds: string[];
  onPlace: (
    sourceId: string,
    targetId: string,
    placement: PanePlacement,
  ) => void;
  onStart: (id: string) => void;
  onFinish: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    started: boolean;
    drop: DropPoint | null;
  } | null>(null);
  const suppressedClick = useRef({ id: "", until: 0 });
  const [touchDrop, setTouchDrop] = useState<DropPoint | null>(null);

  useEffect(() => {
    function finish(event?: PointerEvent) {
      const drag = gesture.current;
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      gesture.current = null;
      if (drag.started) {
        suppressedClick.current = {
          id: drag.id,
          until: performance.now() + 600,
        };
        if (event?.type === "pointerup" && drag.drop)
          latest.current.onPlace(
            drag.id,
            drag.drop.targetId,
            drag.drop.placement,
          );
        latest.current.onFinish();
      }
      setTouchDrop(null);
    }
    function move(event: PointerEvent) {
      const drag = gesture.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (
        !drag.started &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8
      )
        return;
      if (event.cancelable) event.preventDefault();
      if (!drag.started) {
        drag.started = true;
        latest.current.onStart(drag.id);
      }
      const { compact, splitSessionIds } = latest.current;
      let drop: DropPoint | null = null;
      for (const pane of document.querySelectorAll<HTMLElement>(
        ".terminal-session:not([hidden])",
      )) {
        const targetId = pane.dataset.sessionId;
        if (!targetId || targetId === drag.id) continue;
        const rect = pane.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          continue;
        drop = {
          targetId,
          placement:
            splitSessionIds.includes(drag.id) || splitSessionIds.length < 4
              ? paneDropPlacement(
                  event.clientX - rect.left,
                  event.clientY - rect.top,
                  rect.width,
                  rect.height,
                  compact,
                )
              : "center",
        };
        break;
      }
      drag.drop = drop;
      setTouchDrop(drop);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") finish();
    }
    function blur() {
      finish();
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
    };
  }, []);

  function startTouchDrag(event: ReactPointerEvent<HTMLElement>, id: string) {
    if (event.pointerType === "mouse" || !event.isPrimary || event.button !== 0)
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      started: false,
      drop: null,
    };
  }
  return {
    touchDrop,
    startTouchDrag,
    consumeDragClick: (id: string) =>
      suppressedClick.current.id === id &&
      performance.now() < suppressedClick.current.until,
  };
}
