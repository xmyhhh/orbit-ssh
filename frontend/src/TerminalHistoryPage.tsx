import { useMemo, useState } from "react";
import { History, Search, Star, Trash2 } from "lucide-react";
import {
  displayTerminalOutput,
  fuzzyMatch,
  type TerminalHistoryRecord,
} from "./terminalHistory";

interface Props {
  records: TerminalHistoryRecord[];
  recordingEnabled: boolean;
  onOpenSettings: () => void;
  onTogglePin: (record: TerminalHistoryRecord) => void;
  onDelete: (record: TerminalHistoryRecord) => void;
}

const dateTime = (time: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(time);

function preview(output: string) {
  return (
    displayTerminalOutput(output)
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(-3)
      .join("\n") || "没有可显示的输出"
  );
}

export default function TerminalHistoryPage({
  records,
  recordingEnabled,
  onOpenSettings,
  onTogglePin,
  onDelete,
}: Props) {
  const [collection, setCollection] = useState<"recent" | "pinned">("recent");
  const [query, setQuery] = useState("");
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const visibleRecords = useMemo(() => {
    const items = records
      .filter((record) => record.pinned === (collection === "pinned"))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const search = query.trim();
    if (!search) return items;
    return items.filter((record) =>
      fuzzyMatch(
        search,
        `${record.title} ${record.subtitle} ${record.terminalNumber} ${displayTerminalOutput(record.output)}`,
      ),
    );
  }, [collection, query, records]);
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
        </label>
        <span className="history-result-count" role="status">
          {visibleRecords.length} 条记录
        </span>
      </div>
      <div className="history-content">
        <div className="history-list" role="list" aria-label="历史记录列表">
          {visibleRecords.map((record) => (
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
                  <strong>{record.title} · 终端 #{record.terminalNumber}</strong>
                  <time>{dateTime(record.updatedAt)}</time>
                </span>
                <span className="history-record-subtitle">{record.subtitle}</span>
                <pre>{preview(record.output)}</pre>
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
                  aria-label={`删除 ${record.title} 终端 #${record.terminalNumber} 历史`}
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
          ))}
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
                  ? "试试更短的关键词，或清除搜索。"
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
                  {selectedRecord.title} · 终端 #{selectedRecord.terminalNumber}
                </h2>
                <p>{selectedRecord.subtitle}</p>
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
              {displayTerminalOutput(selectedRecord.output) || "没有可显示的输出"}
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
