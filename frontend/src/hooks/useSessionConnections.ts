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
  const connectingIDs = useRef(new Set<string>());
  const reconnectingIDs = useRef(new Set<string>());
  const closedDuringConnect = useRef(new Set<string>());
  const disconnecting = useRef(new Map<string, Promise<void>>());
  const terminalNumbers = useRef(new Map<string, number>());
  const { activateNewSession, pendingSplitRef } = layout;

  function onSessionClosed(id: string, message: string) {
    if (connectingIDs.current.has(id)) closedDuringConnect.current.add(id);
    setSessions((items) => items.map((item) => item.id === id
      ? { ...item, status: "closed", reconnecting: false, error: message }
      : item));
  }

  async function discardSession(session: Session, previousActive: string) {
    const { id, host, terminalNumber } = session;
    connectingIDs.current.delete(id);
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
    if (id) {
      connectingIDs.current.delete(id);
      const cleanup = backend()
        .Disconnect(id)
        .catch(() => {});
      disconnecting.current.set(id, cleanup);
    }
  }
  function allocateSession(
    host: Host,
    id: string = crypto.randomUUID(),
    name?: string,
  ): Session {
    const terminalNumber = (terminalNumbers.current.get(host.id) ?? 0) + 1;
    terminalNumbers.current.set(host.id, terminalNumber);
    return {
      id,
      host,
      terminalNumber,
      name: name?.trim() || undefined,
      demo: false,
      status: "connecting",
    };
  }

  async function connect(
    host: Host,
    credentials: Credentials,
    fingerprint: string,
    mcpSessionID?: string,
    name?: string,
    reconnectID?: string,
  ) {
    if (
      mcpSessionID &&
      (connectingIDs.current.has(mcpSessionID) ||
        sessionsRef.current.some((session) => session.id === mcpSessionID))
    )
      return;
    const previous = reconnectID
      ? sessionsRef.current.find((session) => session.id === reconnectID)
      : undefined;
    if (reconnectID) {
      if (!previous || previous.demo || previous.status !== "closed")
        throw new Error("此终端当前无法重新连接");
      if (reconnectingIDs.current.has(reconnectID))
        throw new Error("上一次连接仍在结束，请稍后重试");
      reconnectingIDs.current.add(reconnectID);
    }
    const session = previous
      ? { ...previous, host, status: "connecting" as const, reconnecting: true, error: undefined }
      : allocateSession(host, mcpSessionID, name);
    const id = session.id;
    const previousActive = active;
    connectingIDs.current.add(id);
    closedDuringConnect.current.delete(id);
    if (!mcpSessionID) connectingID.current = id;
    setSessions((s) => previous
      ? s.map((item) => item.id === id ? session : item)
      : [...s, session]);
    if (previous) {
      setActive(id);
      handles.current.get(id)?.connectionMessage("正在重新连接…", true);
    } else if (mcpSessionID) layout.activateSession(id);
    else activateNewSession(id);
    try {
      const deadline = Date.now() + 5000;
      while (!handles.current.get(id)?.ready()) {
        if (!connectingIDs.current.has(id)) throw new Error("连接已取消");
        if (Date.now() >= deadline) throw new Error("终端界面尚未准备好，请重试");
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      if (!connectingIDs.current.has(id)) throw new Error("连接已取消");
      const size = handles.current.get(id)!.size();
      if (mcpSessionID) await backend().ConnectMCPHost(id, size);
      else await backend().Connect(id, host.id, credentials, fingerprint, size);
      if (!connectingIDs.current.has(id)) {
        await backend().Disconnect(id);
        throw new Error("连接已取消");
      }
      // A remote exit can arrive before the Connect promise resolves.
      setSessions((s) =>
        s.map((item) =>
          item.id === id && item.status !== "closed"
            ? { ...item, status: "connected", reconnecting: false }
            : item,
        ),
      );
      if (previous) {
        const current = sessionsRef.current.find((item) => item.id === id) ?? previous;
        if (!closedDuringConnect.current.has(id)) {
          handles.current.get(id)?.connectionMessage("已重新连接 · 新的 Shell 会话");
          if (current?.name) {
            await backend().RenameSession(id, current.name).catch((e) =>
              notify(`已重新连接，恢复会话名称失败：${errorText(e)}`),
            );
          }
        }
      }
      if (!mcpSessionID) pendingSplitRef.current = null;
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
      if (previous) {
        await backend().Disconnect(id).catch(() => {});
        await disconnecting.current.get(id);
        setSessions((items) => items.map((item) => item.id === id
          ? { ...item, status: "closed", reconnecting: false, error: errorText(e) }
          : item));
        handles.current.get(id)?.connectionMessage(`重新连接失败或已取消：${errorText(e)}`);
      } else await discardSession(session, previousActive);

      throw e;
    } finally {
      connectingIDs.current.delete(id);
      reconnectingIDs.current.delete(id);
      closedDuringConnect.current.delete(id);
      disconnecting.current.delete(id);
      if (connectingID.current === id) connectingID.current = null;
    }
  }
  async function reconnect(
    session: Session,
    host: Host,
    credentials: Credentials,
    fingerprint: string,
  ) {
    await connect(host, credentials, fingerprint, undefined, undefined, session.id);
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
    for (const session of closing) connectingIDs.current.delete(session.id);
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
    reconnect,
    openWSLTerminal,
    openLocalShell,
    removeSession,
    removeSessions,
    cancelConnection,
    onSessionClosed,
  };
}
