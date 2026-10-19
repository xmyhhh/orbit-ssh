import { useEffect, useRef, useState } from "react";
import type { Preferences, Session, TerminalHandle } from "../types";
import { backend, errorText, isDesktop } from "../bridge";
import {
  deleteTerminalHistory,
  saveTerminalHistory,
  trimTerminalHistory,
  trimTerminalHistoryOutput,
  type TerminalHistoryRecord,
} from "../terminalHistory";
import type { RefObject } from "react";
import { sessionAddress, sessionTitle } from "../sessions";

export function useTerminalHistory({
  loading,
  preferences,
  sessionsRef,
  handles,
  notify,
}: {
  loading: boolean;
  preferences: Preferences;
  sessionsRef: RefObject<Session[]>;
  handles: RefObject<Map<string, TerminalHandle>>;
  notify: (message: string) => void;
}) {
  const [terminalHistory, setTerminalHistory] = useState<
    TerminalHistoryRecord[]
  >([]);
  const historyOutputCache = useRef(new Map<string, TerminalHistoryRecord>());
  const historySuppressed = useRef(new Set<string>());
  const historyFailureNotified = useRef(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    void trimTerminalHistory(preferences.terminalHistoryLimit)
      .then((records) => {
        if (cancelled) return;
        for (const record of records)
          if (!historyOutputCache.current.has(record.id))
            historyOutputCache.current.set(record.id, record);
        setTerminalHistory(records);
        if (isDesktop())
          void backend()
            .SyncTerminalHistory(records)
            .catch(reportHistoryFailure);
      })
      .catch((error) => {
        if (cancelled || historyFailureNotified.current) return;
        historyFailureNotified.current = true;
        notify(`读取终端历史失败：${errorText(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, preferences.terminalHistoryLimit]);

  function reportHistoryFailure(error: unknown) {
    if (historyFailureNotified.current) return;
    historyFailureNotified.current = true;
    notify(`保存终端历史失败：${errorText(error)}`);
  }
  function persistTerminalHistory(
    record: TerminalHistoryRecord,
    outputDelta?: string,
  ) {
    historyOutputCache.current.set(record.id, record);
    setTerminalHistory((records) =>
      [record, ...records.filter((item) => item.id !== record.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    );
    void saveTerminalHistory(
      record,
      preferencesRef.current.terminalHistoryLimit,
    )
      .then(async (records) => {
        setTerminalHistory(records);
        if (isDesktop()) {
          const retainedIDs = records.map((item) => item.id);
          const sync =
            outputDelta === undefined
              ? backend().UpsertTerminalHistory(record, retainedIDs)
              : backend().AppendTerminalHistory(
                  record,
                  outputDelta,
                  retainedIDs,
                );
          await sync;
        }
        historyFailureNotified.current = false;
      })
      .catch(reportHistoryFailure);
  }
  function recordTerminalOutput(session: Session, output: string) {
    if (
      !preferencesRef.current.terminalHistoryEnabled ||
      historySuppressed.current.has(session.id)
    )
      return;
    const previous = historyOutputCache.current.get(session.id);
    const now = Date.now();
    const bounded = trimTerminalHistoryOutput(
      `${previous?.output ?? ""}${output}`,
    );
    persistTerminalHistory(
      {
        id: session.id,
        title: sessionTitle(session),
        name: session.name,
        subtitle: sessionAddress(session),
        terminalNumber: session.terminalNumber,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        output: bounded.output,
        pinned: previous?.pinned ?? false,
        truncated: (previous?.truncated ?? false) || bounded.truncated,
      },
      output,
    );
  }
  function setHistoryPinned(record: TerminalHistoryRecord, pinned: boolean) {
    historySuppressed.current.delete(record.id);
    const current = historyOutputCache.current.get(record.id) ?? record;
    persistTerminalHistory({ ...current, pinned });
  }
  function toggleSessionHistory(session: Session) {
    const terminal = handles.current.get(session.id);
    terminal?.flushHistory();
    const previous = historyOutputCache.current.get(session.id);
    const current =
      previous ?? terminalHistory.find((record) => record.id === session.id);
    const now = Date.now();
    const liveBuffer = terminal?.readBuffer() ?? "";
    const buffer = preferencesRef.current.terminalHistoryEnabled
      ? (current?.output ?? liveBuffer)
      : liveBuffer || current?.output || "";
    const bounded = trimTerminalHistoryOutput(buffer);
    historySuppressed.current.delete(session.id);
    persistTerminalHistory({
      id: session.id,
      title: sessionTitle(session),
      name: session.name,
      subtitle: sessionAddress(session),
      terminalNumber: session.terminalNumber,
      createdAt: current?.createdAt ?? now,
      updatedAt: current?.updatedAt ?? now,
      output: bounded.output,
      pinned: !(current?.pinned ?? false),
      truncated: (current?.truncated ?? false) || bounded.truncated,
    });
  }
  function renameTerminalHistory(id: string, name: string) {
    const current =
      historyOutputCache.current.get(id) ??
      terminalHistory.find((record) => record.id === id);
    if (!current) return;
    persistTerminalHistory({ ...current, name: name.trim() || undefined });
  }
  function removeTerminalHistory(record: TerminalHistoryRecord) {
    if (sessionsRef.current.some((session) => session.id === record.id))
      historySuppressed.current.add(record.id);
    historyOutputCache.current.delete(record.id);
    setTerminalHistory((records) =>
      records.filter((item) => item.id !== record.id),
    );
    void deleteTerminalHistory(record.id).catch(reportHistoryFailure);
    if (isDesktop())
      void backend()
        .DeleteTerminalHistory(record.id)
        .catch(reportHistoryFailure);
  }
  return {
    terminalHistory,
    recordTerminalOutput,
    setHistoryPinned,
    toggleSessionHistory,
    renameTerminalHistory,
    removeTerminalHistory,
  };
}
