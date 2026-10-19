interface AndroidMessage {
  type: "result" | "event";
  id?: string;
  name?: string;
  args?: unknown[];
  data?: unknown;
  error?: string;
}

declare global {
  interface Window {
    OrbitAndroid?: { postMessage: (message: string) => void };
    __orbitAndroidReceive?: (message: AndroidMessage) => void;
  }
}

export const isAndroid = () => Boolean(window.OrbitAndroid);
let nextID = 0;
const pending = new Map<
  string,
  { resolve: (data: unknown) => void; reject: (error: Error) => void }
>();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

export function androidCall(
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!window.OrbitAndroid)
      return reject(new Error("此操作需要 Android 应用"));
    const id = String(++nextID);
    pending.set(id, { resolve, reject });
    try {
      window.OrbitAndroid.postMessage(
        JSON.stringify({ type: "call", id, method, args }),
      );
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

if (isAndroid()) {
  document.documentElement.dataset.platform = "android";
  window.__orbitAndroidReceive = (message) => {
    if (message.type === "event" && message.name) {
      for (const callback of listeners.get(message.name) ?? [])
        callback(...(message.args ?? []));
    } else if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.data);
    }
  };
  // Preserve the existing desktop API so all SSH, SFTP, monitoring and editor
  // behavior uses the same backend and components on both platforms.
  window.go = {
    main: {
      App: new Proxy({} as NonNullable<Window["go"]>["main"]["App"], {
        get:
          (_target, method) =>
          (...args: unknown[]) =>
            androidCall(String(method), ...args),
      }),
    },
  };
  window.runtime = {
    ClipboardGetText: async () => String(await androidCall("ClipboardGetText")),
    ClipboardSetText: async (text) =>
      Boolean(await androidCall("ClipboardSetText", text)),
    EventsOnMultiple: (name, callback) => {
      let callbacks = listeners.get(name);
      if (!callbacks) listeners.set(name, (callbacks = new Set()));
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
        if (!callbacks.size) listeners.delete(name);
      };
    },
  };

  // Keep native system bars in sync with the resolved app theme, including
  // changes from the system appearance preference and the toolbar toggle.
  const syncAppearance = () => {
    const root = document.documentElement;
    if (!root.dataset.theme) return;
    const styles = getComputedStyle(root);
    void androidCall(
      "SetSystemAppearance",
      root.dataset.theme === "dark",
      styles.getPropertyValue("--surface").trim(),
      styles.getPropertyValue("--canvas").trim(),
    ).catch(() => {});
  };
  new MutationObserver(syncAppearance).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  syncAppearance();
}
