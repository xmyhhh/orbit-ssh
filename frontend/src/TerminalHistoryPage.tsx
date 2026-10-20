import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { History, Pencil, Search, Star, Trash2, X } from "lucide-react";
import {
  displayTerminalOutput,
  matchRanges,
  matchesSearch,
  terminalHistorySubtitle,
  terminalHistoryTitle,
  type TerminalHistoryRecord,
} from "./terminalHistory";

interface Props {
  records: TerminalHistoryRecord[];
  recordingEnabled: boolean;
  focusID?: string;
  onOpenSettings: () => void;
  onTogglePin: (record: TerminalHistoryRecord) => void;
  onRename: (record: TerminalHistoryRecord) => void;
  onDelete: (record: TerminalHistoryRecord) => void;
}

const dateTime = (time: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(time);

function preview(output: string) {
  return (
    output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(-3)
      .join("\n") || "没有可显示的输出"
  );
}

// Renders the text with every matched term highlighted.
function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = useMemo(() => matchRanges(text, query), [text, query]);
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark className="history-match" key={index}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export default function TerminalHistoryPage({
  records,
  recordingEnabled,
  focusID = "",
  onOpenSettings,
  onTogglePin,
  onRename,
  onDelete,
}: Props) {
  const [collection, setCollection] = useState<"recent" | "pinned">("recent");
  const [query, setQuery] = useState("");
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const searching = deferredQuery.trim().length > 0;

  // Stripping ANSI and building the haystack is expensive on large outputs, so
  // it happens once per record instead of on every keystroke.
  const prepared = useMemo(() => {
    const map = new Map<
      string,
      { display: string; haystack: string; title: string; subtitle: string }
    >();
    for (const record of records) {
      const display = displayTerminalOutput(record.output);
      const title = terminalHistoryTitle(record);
      const subtitle = terminalHistorySubtitle(record);
      map.set(record.id, {
        display,
        title,
        subtitle,
        haystack: `${title} ${subtitle} ${display}`.toLocaleLowerCase(),
      });
    }
    return map;
  }, [records]);

  const visibleRecords = useMemo(() => {
    // A search spans both collections so a record is never hidden behind a tab.
    const items = searching
      ? records.filter((record) =>
          matchesSearch(prepared.get(record.id)?.haystack ?? "", deferredQuery),
        )
      : records.filter((record) => record.pinned === (collection === "pinned"));
    return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [collection, deferredQuery, prepared, records, searching]);

  // Keep a usable selection while filtering; otherwise the detail pane blanks.
  useEffect(() => {
    if (!searching) return;
    if (selectedID && visibleRecords.some((item) => item.id === selectedID))
      return;
    setSelectedID(visibleRecords[0]?.id ?? null);
  }, [searching, selectedID, visibleRecords]);

  useEffect(() => {
    if (!focusID) return;
    setSelectedID(focusID);
    setQuery("");
  }, [focusID]);

  const selectedRecord = visibleRecords.find(
    (record) => record.id === selectedID,
  );
  const recentCount = records.filter((record) => !record.pinned).length;
  const pinnedCount = records.filter((record) => record.pinned).length;

  return (
    <section className="terminal-history-page" aria-label="终端历史">
      <div className="page-heading">
        <div>
          <h1>终端历史</h1>
          <p>本机保存的终端输出</p>
        </div>
      </div>
      <div className="history-controls">
        <div className="history-tabs" role="tablist" aria-label="历史类别">
          <button
            role="tab"
            aria-selected={collection === "recent"}
            className={collection === "recent" ? "selected" : ""}
            onClick={() => setCollection("recent")}
          >
            最近 <span>{recentCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={collection === "pinned"}
            className={collection === "pinned" ? "selected" : ""}
            onClick={() => setCollection("pinned")}
          >
            <Star size={14} aria-hidden="true" />
            精选 <span>{pinnedCount}</span>
          </button>
        </div>
        <label className="history-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索终端历史"
            placeholder="搜索主机、地址或输出…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              className="history-search-clear"
              type="button"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </label>
        <span className="history-result-count" role="status">
          {searching
            ? `${visibleRecords.length} / ${records.length} 条匹配`
            : `${visibleRecords.length} 条记录`}
        </span>
      </div>
      {searching && (
        <p className="history-search-note">
          搜索范围包含「最近」和「精选」的全部记录，按关键词匹配标题、地址与终端输出。
        </p>
      )}
      <div className="history-content">
        <div className="history-list" role="list" aria-label="历史记录列表">
          {visibleRecords.map((record) => {
            const info = prepared.get(record.id);
            return (
              <article
                className={`history-row ${selectedID === record.id ? "selected" : ""}`}
                key={record.id}
              >
                <button
                  className="history-record"
                  role="listitem"
                  aria-pressed={selectedID === record.id}
                  onClick={() => setSelectedID(record.id)}
                >
                  <span className="history-record-heading">
                    <strong>
                      <Highlighted
                        text={info?.title ?? terminalHistoryTitle(record)}
                        query={deferredQuery}
                      />
                    </strong>
                    {searching && (
                      <span
                        className={`history-record-tag ${
                          record.pinned ? "pinned" : ""
                        }`}
                      >
                        {record.pinned ? "精选" : "最近"}
                      </span>
                    )}
                    <time>{dateTime(record.updatedAt)}</time>
                  </span>
                  <span className="history-record-subtitle">
                    <Highlighted
                      text={info?.subtitle ?? terminalHistorySubtitle(record)}
                      query={deferredQuery}
                    />
                  </span>
                  <pre>
                    <Highlighted
                      text={preview(info?.display ?? "")}
                      query={deferredQuery}
                    />
                  </pre>
                  {record.truncated && (
                    <small>较早输出已省略，仅保留最近内容</small>
                  )}
                </button>
                <div className="history-row-actions">
                  <button
                    className={`icon-button ${record.pinned ? "selected" : ""}`}
                    aria-label={record.pinned ? "取消精选" : "加入精选"}
                    title={record.pinned ? "取消精选" : "加入精选"}
                    aria-pressed={record.pinned}
                    onClick={() => onTogglePin(record)}
                  >
                    <Star
                      size={15}
                      fill={record.pinned ? "currentColor" : "none"}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`重命名 ${terminalHistoryTitle(record)}`}
                    title="重命名"
                    onClick={() => onRename(record)}
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除 ${terminalHistoryTitle(record)} 历史`}
                    title="删除历史"
                    onClick={() => {
                      onDelete(record);
                      if (selectedID === record.id) setSelectedID(null);
                    }}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
          {!visibleRecords.length && (
            <div className="history-empty">
              <History size={25} aria-hidden="true" />
              <strong>
                {query
                  ? "没有匹配的历史记录"
                  : collection === "pinned"
                    ? "还没有精选历史"
                    : "暂无终端历史"}
              </strong>
              <p>
                {query
                  ? "搜索会同时查找「最近」和「精选」。换个关键词，或清除搜索。"
                  : collection === "pinned"
                    ? "在终端工具栏点击星标，将记录加入精选。"
                    : recordingEnabled
                      ? "连接终端后，输出会保存在此设备上。"
                      : "记录功能已关闭，已有历史仍可查看。"}
              </p>
              {!recordingEnabled && !query && collection === "recent" && (
                <button className="text-button" onClick={onOpenSettings}>
                  打开偏好设置
                </button>
              )}
              {query && (
                <button className="text-button" onClick={() => setQuery("")}>
                  清除搜索
                </button>
              )}
            </div>
          )}
        </div>
        {selectedRecord ? (
          <section className="history-detail" aria-label="历史输出详情">
            <header>
              <div>
                <h2>
                  <Highlighted
                    text={
                      prepared.get(selectedRecord.id)?.title ??
                      terminalHistoryTitle(selectedRecord)
                    }
                    query={deferredQuery}
                  />
                </h2>
                <p>
                  <Highlighted
                    text={
                      prepared.get(selectedRecord.id)?.subtitle ??
                      terminalHistorySubtitle(selectedRecord)
                    }
                    query={deferredQuery}
                  />
                </p>
                <time>最近记录于 {dateTime(selectedRecord.updatedAt)}</time>
              </div>
              <div>
                <button
                  className={`icon-button ${selectedRecord.pinned ? "selected" : ""}`}
                  aria-label={selectedRecord.pinned ? "取消精选" : "加入精选"}
                  title={selectedRecord.pinned ? "取消精选" : "加入精选"}
                  aria-pressed={selectedRecord.pinned}
                  onClick={() => onTogglePin(selectedRecord)}
                >
                  <Star
                    size={16}
                    fill={selectedRecord.pinned ? "currentColor" : "none"}
                    aria-hidden="true"
                  />
                </button>
                <button
                  className="icon-button"
                  aria-label="重命名当前历史"
                  title="重命名"
                  onClick={() => onRename(selectedRecord)}
                >
                  <Pencil size={16} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  aria-label="删除当前历史"
                  title="删除历史"
                  onClick={() => {
                    onDelete(selectedRecord);
                    setSelectedID(null);
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </header>
            {selectedRecord.truncated && (
              <p className="history-truncated-note">
                较早输出已省略，仅保留最近部分。
              </p>
            )}
            <pre className="history-transcript">
              {prepared.get(selectedRecord.id)?.display ||
                displayTerminalOutput(selectedRecord.output) ||
                "没有可显示的输出"}
            </pre>
          </section>
        ) : (
          <div className="history-detail history-detail-empty">
            <History size={25} aria-hidden="true" />
            <span>选择一条记录查看终端输出</span>
          </div>
        )}
      </div>
    </section>
  );
}
