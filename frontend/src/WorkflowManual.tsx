import { useState } from "react";
import {
  Check,
  CircleAlert,
  Copy,
  Pencil,
  Play,
  RotateCcw,
  SkipForward,
  TerminalSquare,
} from "lucide-react";
import { writeClipboard } from "./bridge";
import {
  commandLooksDestructive,
  renderWorkflowCommand,
  type StepStatus,
  type Workflow,
  type WorkflowStep,
} from "./workflows";

interface Props {
  workflow: Workflow;
  runtimeValues: Record<string, string>;
  runtimeCommands: Record<string, string>;
  statuses: Record<string, StepStatus>;
  sessionBindings: Record<string, string>;
  onExecute: (step: WorkflowStep, command: string) => void;
  onStatus: (stepID: string, status: StepStatus) => void;
  onCommandOverride: (stepID: string, command: string) => void;
  onViewTerminal: (sessionID: string) => void;
  onNotice: (message: string) => void;
}

const statusText: Record<StepStatus, string> = {
  pending: "未执行",
  sent: "已发送",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

function statusIcon(status: StepStatus) {
  if (status === "completed") return <Check size={14} />;
  if (status === "failed") return <CircleAlert size={14} />;
  if (status === "skipped") return <SkipForward size={14} />;
  if (status === "sent") return <TerminalSquare size={14} />;
  return <span className="workflow-step-dot" />;
}

/**
 * The manual view: every entry is visible at once and can be run on its own.
 * Nothing here depends on the order of the list.
 */
export default function WorkflowManual({
  workflow,
  runtimeValues,
  runtimeCommands,
  statuses,
  sessionBindings,
  onExecute,
  onStatus,
  onCommandOverride,
  onViewTerminal,
  onNotice,
}: Props) {
  const [editingID, setEditingID] = useState("");
  const [confirmID, setConfirmID] = useState("");

  const done = workflow.steps.filter(
    (step) => (statuses[step.id] ?? "pending") === "completed",
  ).length;

  function resolve(step: WorkflowStep) {
    const template = runtimeCommands[step.id] ?? step.command;
    try {
      return {
        value: renderWorkflowCommand(
          template,
          runtimeValues,
          workflow.parameters,
        ),
        error: "",
      };
    } catch (error) {
      return { value: "", error: String(error).replace(/^Error: /, "") };
    }
  }

  async function copyCommand(step: WorkflowStep) {
    const text = resolve(step).value || step.command;
    if (!text.trim()) {
      onNotice("此条目没有命令可复制。");
      return;
    }
    try {
      await writeClipboard(text);
      onNotice("命令已复制到剪贴板。");
    } catch {
      onNotice("复制失败，请手动选择命令文本。");
    }
  }

  return (
    <section className="workflow-manual" aria-label="工作流条目">
      <div className="workflow-manual-toolbar">
        <span>
          共 {workflow.steps.length} 条，已完成 {done} 条
        </span>
        <button
          className="text-button"
          onClick={() => {
            for (const step of workflow.steps) onStatus(step.id, "pending");
            setConfirmID("");
            setEditingID("");
          }}
          disabled={!done}
        >
          <RotateCcw size={13} />
          重置全部状态
        </button>
      </div>

      {workflow.steps.map((step) => {
        const status = statuses[step.id] ?? "pending";
        const command = resolve(step);
        const dangerous =
          commandLooksDestructive(command.value) || /[\r\n]/.test(command.value);
        const terminal = workflow.terminals.find(
          (item) => item.id === step.terminalId,
        );
        const sessionID = sessionBindings[step.terminalId] ?? "";
        return (
          <article
            className={`workflow-manual-entry status-${status}`}
            key={step.id}
          >
            <header className="workflow-manual-entry-heading">
              <span className="workflow-manual-entry-status">
                {statusIcon(status)}
              </span>
              <div className="workflow-manual-entry-copy">
                <h4>{step.title || "未命名条目"}</h4>
                {step.description && <p>{step.description}</p>}
              </div>
              <span className="workflow-manual-entry-terminal">
                {terminal?.label ?? "未指定终端"}
              </span>
            </header>

            <div className="workflow-command-block">
              {editingID === step.id ? (
                <textarea
                  className="workflow-command-editor"
                  rows={3}
                  spellCheck={false}
                  value={runtimeCommands[step.id] ?? step.command}
                  onChange={(event) => {
                    setConfirmID("");
                    onCommandOverride(step.id, event.currentTarget.value);
                  }}
                />
              ) : (
                <pre className="workflow-command-preview">
                  {command.value ||
                    command.error ||
                    step.command ||
                    "此条目没有命令，由你手动完成。"}
                </pre>
              )}
              {command.error && (
                <p className="workflow-error">{command.error}</p>
              )}
            </div>

            <div className="workflow-manual-entry-actions">
              {step.command ? (
                <button
                  className={`button ${dangerous && confirmID === step.id ? "danger" : "primary"} compact`}
                  disabled={Boolean(command.error)}
                  onClick={() => {
                    if (!dangerous) {
                      onExecute(step, command.value);
                      return;
                    }
                    if (confirmID !== step.id) {
                      setConfirmID(step.id);
                      return;
                    }
                    onExecute(step, command.value);
                  }}
                >
                  <Play size={14} />
                  {dangerous
                    ? confirmID === step.id
                      ? "确认发送命令"
                      : "检查命令后确认"
                    : status === "pending" || status === "skipped"
                      ? "执行此条"
                      : "重跑此条"}
                </button>
              ) : (
                <button
                  className="button primary compact"
                  onClick={() => onStatus(step.id, "completed")}
                >
                  <Check size={14} />
                  标记完成
                </button>
              )}
              <button
                className="button secondary compact"
                onClick={() => onStatus(step.id, "completed")}
                disabled={status === "completed"}
              >
                <Check size={14} />
                标记完成
              </button>
              <button
                className="button secondary compact"
                onClick={() => {
                  onStatus(step.id, "skipped");
                  setConfirmID("");
                }}
              >
                <SkipForward size={14} />
                跳过
              </button>
              <button
                className="icon-button"
                title="复制命令"
                aria-label="复制命令"
                onClick={() => void copyCommand(step)}
                disabled={!step.command.trim()}
              >
                <Copy size={15} />
              </button>
              <button
                className="icon-button"
                title="调整本次命令"
                aria-label="调整本次命令"
                onClick={() => {
                  setConfirmID("");
                  setEditingID((current) =>
                    current === step.id ? "" : step.id,
                  );
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon-button"
                title="标记失败"
                aria-label="标记失败"
                onClick={() => onStatus(step.id, "failed")}
              >
                <CircleAlert size={15} />
              </button>
              {sessionID && (
                <button
                  className="icon-button"
                  title="查看终端"
                  aria-label="查看所选终端"
                  onClick={() => onViewTerminal(sessionID)}
                >
                  <TerminalSquare size={16} />
                </button>
              )}
              {status !== "pending" && (
                <button
                  className="icon-button"
                  title="重置此条状态"
                  aria-label="重置此条状态"
                  onClick={() => onStatus(step.id, "pending")}
                >
                  <RotateCcw size={15} />
                </button>
              )}
              <span className="workflow-manual-entry-status-text">
                {statusText[status]}
              </span>
            </div>
          </article>
        );
      })}
    </section>
  );
}
