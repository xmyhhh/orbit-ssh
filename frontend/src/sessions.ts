import type { Host, LocalShell, Session } from "./types";

export type LocalSessionTarget =
  | { localShell: LocalShell; wslDistribution?: never }
  | { wslDistribution: string; localShell?: never };

export function isLocalSession(session?: Session) {
  return Boolean(session?.localShell || session?.wslDistribution);
}

export function sessionAddress(session: Session) {
  if (session.localShell) return `本地 · ${session.localShell.name}`;
  if (session.wslDistribution) return `WSL · ${session.wslDistribution}`;
  return `${session.host.username}@${session.host.address}:${session.host.port}`;
}

export function sessionTitle(session: Session) {
  return (
    session.localShell?.name ||
    (session.wslDistribution
      ? `WSL · ${session.wslDistribution}`
      : session.host.name)
  );
}

export function sessionDefaultName(session: Session) {
  return `终端 #${session.terminalNumber}`;
}

/** The label used for tabs and other compact session pickers. */
export function sessionName(session: Session) {
  return session.name?.trim() || sessionDefaultName(session);
}

/** The heading shown above a terminal or split pane. */
export function sessionHeading(session: Session) {
  return session.name?.trim() || sessionTitle(session);
}

/** A descriptive label for confirmations, menus and workflow targets. */
export function sessionDetailLabel(session: Session) {
  return session.name?.trim()
    ? `${session.name.trim()} · ${sessionTitle(session)}`
    : `${sessionTitle(session)} · ${sessionDefaultName(session)}`;
}

export function localSessionHost(target: LocalSessionTarget): Host {
  const name = target.localShell
    ? target.localShell.name
    : target.wslDistribution;
  return {
    id: target.localShell
      ? `local:${target.localShell.id}`
      : `wsl:${target.wslDistribution}`,
    name,
    address: name,
    port: 0,
    username: "",
    group: target.localShell ? "本地 Shell" : "WSL",
    authType: "password",
    keyPath: "",
    color: "mint",
    favorite: false,
    lastConnected: "",
  };
}

/** Keep a visible split pane selected, then prefer a terminal from the same host. */
export function sessionAfterRemoval(
  sessions: Session[],
  removed: ReadonlySet<string>,
  current: string,
  visibleIds: readonly string[],
): string {
  if (!removed.has(current)) return current;
  const visible = visibleIds.filter((id) => !removed.has(id));
  if (visibleIds.includes(current) && visible.length) return visible[0];
  const remaining = sessions.filter((session) => !removed.has(session.id));
  const selected = sessions.find((session) => session.id === current);
  const siblings = sessions.filter(
    (session) => session.host.id === selected?.host.id,
  );
  const survivingSiblings = remaining.filter(
    (session) => session.host.id === selected?.host.id,
  );
  return (
    survivingSiblings[
      Math.min(
        siblings.findIndex((session) => session.id === current),
        survivingSiblings.length - 1,
      )
    ]?.id ??
    remaining[
      Math.min(
        sessions.findIndex((session) => session.id === current),
        remaining.length - 1,
      )
    ]?.id ??
    "home"
  );
}
