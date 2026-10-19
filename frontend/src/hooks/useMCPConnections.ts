import { useEffect, useRef } from "react";
import { errorText, isDesktop, listen } from "../bridge";
import { isAndroid } from "../android";
import type { Host } from "../types";
import type { useSessionConnections } from "./useSessionConnections";

interface MCPConnectionEvent {
  sessionId: string;
  host: Host;
}

export function useMCPConnections(options: {
  enabled: boolean;
  connect: ReturnType<typeof useSessionConnections>["connect"];
  onHost: (host: Host) => void;
  onOpen: () => void;
  notify: (message: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!options.enabled || !isDesktop() || isAndroid()) return;
    const offHost = listen("mcp:host-created", (value) => {
      const host = value as Host;
      latest.current.onHost(host);
      latest.current.notify(`AI 已添加主机 ${host.name}`);
    });
    const offConnect = listen("mcp:connect", (value) => {
      const { sessionId, host } = value as MCPConnectionEvent;
      latest.current.onHost(host);
      latest.current.onOpen();
      void latest.current
        .connect(host, { password: "", passphrase: "" }, "", sessionId)
        .catch((error) => latest.current.notify(errorText(error)));
    });
    return () => {
      offHost();
      offConnect();
    };
  }, [options.enabled]);
}
