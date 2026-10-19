import { useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  Host,
  LocalShell,
  Session,
  TerminalHandle,
  Workspace,
  Credentials,
} from "../types";
import { backend, errorText, isDesktop } from "../bridge";
import {
  localSessionHost,
  sessionAfterRemoval,
  type LocalSessionTarget,
} from "../sessions";
import type { TerminalLayoutController } from "./useTerminalLayout";

export function useSessionConnections({
  sessionsRef,
  setSessions,
  active,
  setActive,
  handles,
  layout,
  stateRef,
  update,
  onOpenLocal,
  notify,
}: {
  sessionsRef: RefObject<Session[]>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  active: string;
  setActive: Dispatch<SetStateAction<string>>;
  handles: RefObject<Map<string, TerminalHandle>>;
  layout: TerminalLayoutController;
  stateRef: RefObject<Workspace>;
  update: (value: Workspace) => void;
  onOpenLocal: () => void;
  notify: (message: string) => void;
}) {
  const connectingID = useRef<string | null>(null);
  const terminalNumbers = useRef(new Map<string, number>());
  const { activateNewSession, pendingSplitRef } = layout;

  async function discardSession(session: Session, previousActive: string) {
    const { id, host, terminalNumber } = session;
    await backend()
      .Disconnect(id)
      .catch(() => {});
    if (terminalNumbers.current.get(host.id) === terminalNumber)
      terminalNumbers.current.set(host.id, terminalNumber - 1);
    setSessions((items) => items.filter((item) => item.id !== id));
    setActive((current) =>
      current === id
        ? sessionsRef.current.some((item) => item.id === previousActive)
          ? previousActive
          : "home"
        : current,
    );
  }
  function cancelConnection() {
    const id = connectingID.current;
    connectingID.current = null;
    if (id)
      void backend()
        .Disconnect(id)
        .catch(() => {});
  }
  function allocateSession(host: Host): Session {
    const terminalNumber = (terminalNumbers.current.get(host.id) ?? 0) + 1;
    terminalNumbers.current.set(host.id, terminalNumber);
    return {
      id: crypto.randomUUID(),
      host,
      terminalNumber,
      demo: false,
      status: "connecting",
    };
  }

  async function connect(
    host: Host,
    credentials: Credentials,
    fingerprint: string,
  ) {
    const session = allocateSession(host);
    const id = session.id;
    const previousActive = active;
    connectingID.current = id;
    setSessions((s) => [...s, session]);
    activateNewSession(id);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    try {
      if (connectingID.current !== id) throw new Error("连接已取消");
      await backend().Connect(
        id,
        host.id,
        credentials,
        fingerprint,
        handles.current.get(id)?.size() ?? { cols: 100, rows: 30 },
      );
      if (connectingID.current !== id) {
        await backend().Disconnect(id);
        throw new Error("连接已取消");
      }
      // A remote exit can arrive before the Connect promise resolves.
      setSessions((s) =>
        s.map((item) =>
          item.id === id && item.status !== "closed"
            ? { ...item, status: "connected" }
            : item,
        ),
      );
      pendingSplitRef.current = null;
      update({
        ...stateRef.current,
        hosts: stateRef.current.hosts.map((h) =>
          h.id === host.id
            ? { ...h, lastConnected: new Date().toISOString() }
            : h,
        ),
      });
      if (host.authType === "password") {
        try {
          if (credentials.rememberPassword && credentials.password) {
            await backend().SavePassword(host.id, credentials.password);
          } else if (credentials.rememberPassword === false) {
            await backend().ForgetPassword(host.id);
          }
        } catch (e) {
          notify(
            `已连接，密码${credentials.rememberPassword === false ? "清除" : "保存"}失败：${errorText(e)}`,
          );
          return;
        }
      }
      if (
        host.authType === "key" &&
        credentials.rememberKey &&
        credentials.passphrase
      ) {
        try {
          await backend().SaveKeyPassphrase(host.id, credentials.passphrase);
        } catch (e) {
          notify(`已连接，口令保存失败：${errorText(e)}`);
          return;
        }
      }
      notify(`已连接 ${host.name}`);
    } catch (e) {
      await discardSession(session, previousActive);

      throw e;
    } finally {
      if (connectingID.current === id) connectingID.current = null;
    }
  }
  async function openWSLTerminal(distribution: string) {
    await openLocalSession({ wslDistribution: distribution });
  }
  async function openLocalShell(shell: LocalShell) {
    await openLocalSession({ localShell: shell });
  }
  async function openLocalSession(target: LocalSessionTarget) {
    const host = localSessionHost(target);

    const session = { ...allocateSession(host), ...target };
    const previousActive = active;
    setSessions((items) => [...items, session]);
    activateNewSession(session.id);
    onOpenLocal();

    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (!sessionsRef.current.some((item) => item.id === session.id)) return;
      const size = handles.current.get(session.id)?.size() ?? {
        cols: 100,
        rows: 30,
      };
      if (target.localShell)
        await backend().ConnectLocalShell(
          session.id,
          target.localShell.id,
          size,
        );
      else await backend().ConnectWSL(session.id, target.wslDistribution, size);
      if (!sessionsRef.current.some((item) => item.id === session.id)) {
        await backend().Disconnect(session.id);
        return;
      }
      setSessions((items) =>
        items.map((item) =>
          item.id === session.id && item.status !== "closed"
            ? { ...item, status: "connected" }
            : item,
        ),
      );
    } catch (e) {
      await discardSession(session, previousActive);

      notify(errorText(e));
    } finally {
      pendingSplitRef.current = null;
    }
  }
  async function removeSession(id: string) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session) await removeSessions([session]);
  }
  async function removeSessions(closing: Session[]) {
    const results = await Promise.allSettled(
      closing.map((s) =>
        isDesktop() && !s.demo ? backend().Disconnect(s.id) : Promise.resolve(),
      ),
    );
    const removed = new Set(
      closing
        .filter((_, i) => results[i].status === "fulfilled")
        .map((s) => s.id),
    );
    const items = sessionsRef.current;
    setSessions((s) => s.filter((item) => !removed.has(item.id)));
    setActive((current) =>
      sessionAfterRemoval(items, removed, current, layout.splitSessionIds),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return {
    connect,
    openWSLTerminal,
    openLocalShell,
    removeSession,
    removeSessions,
    cancelConnection,
  };
}
