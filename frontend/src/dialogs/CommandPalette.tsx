import { useDeferredValue, useMemo, useState } from "react";
import {
  ChevronRight,
  History,
  KeyRound,
  Search,
  TerminalSquare,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { Host } from "../types";
import type { TerminalHistoryRecord } from "../terminalHistory";
import {
  displayTerminalOutput,
  terminalHistoryTitle,
} from "../terminalHistory";
import { loadWorkflows, type Workflow } from "../workflows";
import { Modal } from "./Modal";

const historyPreviewLimit = 4000;

export function CommandPalette({
  hosts,
  history,
  onSelectHost,
  onSelectWorkflow,
  onSelectHistory,
  onNew,
  onClose,
}: {
  hosts: Host[];
  history: TerminalHistoryRecord[];
  onSelectHost: (host: Host) => void;
  onSelectWorkflow: (workflow: Workflow) => void;
  onSelectHistory: (record: TerminalHistoryRecord) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const search = deferredQuery.trim().toLocaleLowerCase();
  const workflows = useMemo(() => loadWorkflows(), []);

  const hostMatches = useMemo(
    () =>
      hosts.filter((host) =>
        `${host.name} ${host.address} ${host.username} ${host.group}`
          .toLocaleLowerCase()
          .includes(search),
      ),
    [hosts, search],
  );

  const workflowMatches = useMemo(
    () =>
      workflows.filter((workflow) =>
        `${workflow.title} ${workflow.description} ${workflow.steps
          .map((step) => `${step.title} ${step.command}`)
          .join(" ")}`
          .toLocaleLowerCase()
          .includes(search),
      ),
    [search, workflows],
  );

  // Stripping ANSI for every record is expensive, so it is done once and the
  // output tail is only indexed for the most recent entries.
  const historyIndex = useMemo(
    () =>
      history.map((record) => {
        const display = displayTerminalOutput(record.output);
        return {
          record,
          haystack: `${terminalHistoryTitle(record)} ${record.subtitle} ${display
            .slice(-historyPreviewLimit)
            .toLocaleLowerCase()}`,
        };
      }),
    [history],
  );

  const historyMatches = useMemo(
    () =>
      historyIndex
        .filter((item) => item.haystack.includes(search))
        .slice(0, 30),
    [historyIndex, search],
  );

  const total =
    hostMatches.length + workflowMatches.length + historyMatches.length;

  return (
    <Modal title="快速搜索" onClose={onClose} wide>
      <div className="palette-search">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索主机、工作流或终端历史…"
          aria-label="快速搜索"
        />
      </div>
      <div className="palette-results">
        {hostMatches.length > 0 && (
          <section className="palette-section">
            <p className="palette-section-title">
              主机 <span>{hostMatches.length}</span>
            </p>
            {hostMatches.map((host) => (
              <button
                className="palette-item"
                key={host.id}
                onClick={() => {
                  onClose();
                  onSelectHost(host);
                }}
              >
                <span className={`host-icon small ${host.color}`}>
                  <TerminalSquare size={18} />
                </span>
                <span className="palette-item-copy">
                  <strong>{host.name}</strong>
                  <code>
                    {host.username}@{host.address}
                  </code>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </section>
        )}

        {workflowMatches.length > 0 && (
          <section className="palette-section">
            <p className="palette-section-title">
              工作流 <span>{workflowMatches.length}</span>
            </p>
            {workflowMatches.map((workflow) => (
              <button
                className="palette-item"
                key={workflow.id}
                onClick={() => {
                  onClose();
                  onSelectWorkflow(workflow);
                }}
              >
                <span className="palette-icon">
                  <WorkflowIcon size={17} />
                </span>
                <span className="palette-item-copy">
                  <strong>{workflow.title}</strong>
                  <code>{workflow.steps.length} 个步骤</code>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </section>
        )}

        {historyMatches.length > 0 && (
          <section className="palette-section">
            <p className="palette-section-title">
              终端历史 <span>{historyMatches.length}</span>
            </p>
            {historyMatches.map(({ record }) => (
              <button
                className="palette-item"
                key={record.id}
                onClick={() => {
                  onClose();
                  onSelectHistory(record);
                }}
              >
                <span className="palette-icon">
                  <History size={17} />
                </span>
                <span className="palette-item-copy">
                  <strong>{terminalHistoryTitle(record)}</strong>
                  <code>{record.subtitle}</code>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </section>
        )}

        {!total && (
          <p className="palette-empty">
            {hosts.length || workflows.length
              ? "没有找到匹配的内容"
              : "还没有主机和工作流，先添加一个吧。"}
          </p>
        )}

        <section className="palette-section palette-section-actions">
          <button
            className="palette-item"
            onClick={() => {
              onClose();
              onNew();
            }}
          >
            <span className="palette-icon">
              <KeyRound size={17} />
            </span>
            <span className="palette-item-copy">
              <strong>添加新主机</strong>
            </span>
            <kbd>Ctrl T</kbd>
          </button>
        </section>
      </div>
    </Modal>
  );
}
