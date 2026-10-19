import { useEffect, useRef, useState } from "react";
import { androidCall, isAndroid } from "../android";
import { listen } from "../bridge";

const mobileViewport = () =>
  isAndroid() ||
  window.innerWidth <= 720 ||
  matchMedia("(pointer: coarse)").matches;

export function useTerminalViewport(hasTerminal: boolean, suspended: boolean) {
  const [mobile, setMobile] = useState(mobileViewport);
  const [fullscreen, setFullscreen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [height, setHeight] = useState(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
  const baseline = useRef({ width: window.innerWidth, height });
  useEffect(() => {
    const viewport = window.visualViewport;
    function resize() {
      const height = viewport?.height ?? window.innerHeight;
      const width = window.innerWidth;
      if (Math.abs(width - baseline.current.width) > 100)
        baseline.current = { width, height };
      else baseline.current.height = Math.max(baseline.current.height, height);
      setHeight(height);
      setMobile(mobileViewport());
      if (!isAndroid())
        setKeyboardVisible(baseline.current.height - height > 140);
    }
    resize();
    window.addEventListener("resize", resize);
    viewport?.addEventListener("resize", resize);
    const unlisten = listen("android:viewport", (value) => {
      setKeyboardVisible(
        Boolean((value as { keyboardVisible: boolean }).keyboardVisible),
      );
      resize();
    });
    return () => {
      window.removeEventListener("resize", resize);
      viewport?.removeEventListener("resize", resize);
      unlisten();
    };
  }, []);
  useEffect(() => {
    if (!hasTerminal) setFullscreen(false);
  }, [hasTerminal]);
  useEffect(() => {
    if (!isAndroid()) return;
    void androidCall("SetTerminalFullscreen", fullscreen).catch(() => {});
    return () => {
      if (fullscreen)
        void androidCall("SetTerminalFullscreen", false).catch(() => {});
    };
  }, [fullscreen]);
  useEffect(() => {
    if (!fullscreen || suspended) return;
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setFullscreen(false);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [fullscreen, suspended]);
  return {
    mobile,
    fullscreen: fullscreen && hasTerminal,
    keyboardVisible,
    viewportHeight: mobile ? `${height}px` : undefined,
    toggleFullscreen: () => setFullscreen((current) => !current),
    exitFullscreen: () => setFullscreen(false),
  };
}
