import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  FileInput,
  FileOutput,
  ListPlus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  TerminalSquare,
  Trash2,
  X,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { Session } from "./types";
import {
  commandLooksDestructive,
  exportWorkflow,
  isBuiltInWorkflow,
  loadWorkflows,
  markBuiltInDeleted,
  newWorkflow,
  parseWorkflowFile,
  renderWorkflowCommand,
  saveWorkflows,
  setWorkflowMode,
  subscribeWorkflowsUpdated,
  validateWorkflow,
  workflowModeHint,
  workflowModeLabel,
  workflowSecretWarnings,
  type StepStatus,
  type Workflow,
  type WorkflowMode,
  type WorkflowStep,
} from "./workflows";
import WorkflowManual from "./WorkflowManual";
import { isLocalSession, sessionDetailLabel } from "./sessions";
import { Select } from "./ui/Select";
import { writeClipboard } from "./bridge";

interface Props {
  sessions: Session[];
  activeSessionId: string;
  targetHostID?: string;
  mode?: "library" | "panel";
  initialWorkflowID?: string;
  hidden?: boolean;
  onRunCommand: (sessionId: string, command: string) => void;
  onViewTerminal: (sessionId: string) => void;
  onExecuteWorkflow?: (workflow: Workflow) => void;
  onClosePanel?: () => void;
}

const statusText: Record<StepStatus, string> = {
  pending: "待执行",
  sent: "已发送",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const statusIcon = (status: StepStatus) => {
  if (status === "completed") return <CircleCheck size={15} />;
  if (status === "failed") return <CircleAlert size={15} />;
  if (status === "skipped") return <SkipForward size={15} />;
  if (status === "sent") return <TerminalSquare size={15} />;
  return <span className="workflow-step-dot" />;
};

function terminalLabel(session: Session) {
  return sessionDetailLabel(session);
}

function safeFilename(title: string) {
  return (
    title.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "workflow"
  );
}

function updateStep(
  workflow: Workflow,
  stepID: string,
  update: (step: WorkflowStep) => WorkflowStep,
): Workflow {
  return {
    ...workflow,
    steps: workflow.steps.map((step) =>
      step.id === stepID ? update(step) : step,
    ),
  };
}

export default function WorkflowPage({
  sessions,
  activeSessionId,
  targetHostID,
  mode = "library",
  initialWorkflowID,
  hidden = false,
  onRunCommand,
  onViewTerminal,
  onExecuteWorkflow,
  onClosePanel,
}: Props) {
  const panel = mode === "panel";
  const [workflows, setWorkflows] = useState(loadWorkflows);
  const [selectedID, setSelectedID] = useState(() =>
    panel ? (initialWorkflowID ?? "") : (workflows[0]?.id ?? ""),
  );
  const selected = workflows.find((workflow) => workflow.id === selectedID);
  const [selectedStepID, setSelectedStepID] = useState("");
  const selectedStep = selected?.steps.find(
    (step) => step.id === selectedStepID,
  );
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>(
    {},
  );
  const [runtimeCommands, setRuntimeCommands] = useState<
    Record<string, string>
  >({});
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>(
    {},
  );
  const [sessionBindings, setSessionBindings] = useState<
    Record<string, string>
  >({});
  const [editingCommandID, setEditingCommandID] = useState<string | null>(null);
  const [editingStepID, setEditingStepID] = useState<string | null>(null);
  const [stepTitleDraft, setStepTitleDraft] = useState("");
  const [stepCommandDraft, setStepCommandDraft] = useState("");
  const [confirmStepID, setConfirmStepID] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(
    () => subscribeWorkflowsUpdated(() => setWorkflows(loadWorkflows())),
    [],
  );

  // The quick search can ask the library page to focus one workflow.
  useEffect(() => {
    if (panel || !initialWorkflowID) return;
    if (!workflows.some((workflow) => workflow.id === initialWorkflowID))
      return;
    setSelectedID(initialWorkflowID);
    setDraft(null);
  }, [initialWorkflowID, panel, workflows]);

  const availableSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.status === "connected" &&
          !session.demo &&
          !isLocalSession(session) &&
          (!targetHostID || session.host.id === targetHostID),
      ),
    [sessions, targetHostID],
  );

  useEffect(() => {
    if (selected) return;
    if (panel) {
      setSelectedStepID("");
      return;
    }
    if (workflows.length) setSelectedID(workflows[0].id);
    else setSelectedID("");
  }, [selected, workflows, panel]);

  useEffect(() => {
    if (!selected) {
      setSelectedStepID("");
      return;
    }
    setSelectedStepID(selected.steps[0]?.id ?? "");
    setRuntimeValues(
      Object.fromEntries(
        selected.parameters.map((parameter) => [
          parameter.name,
          parameter.defaultValue,
        ]),
      ),
    );
    setRuntimeCommands({});
    setStepStatuses({});
    setEditingCommandID(null);
    setEditingStepID(null);
    setConfirmStepID(null);
  }, [selectedID]);

  useEffect(() => {
    if (!selected) return;
    setSessionBindings((current) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const terminal of selected.terminals) {
        const currentID = current[terminal.id];
        next[terminal.id] =
          (currentID &&
          availableSessions.some((session) => session.id === currentID)
            ? currentID
            : "") ||
          (activeSessionId &&
          availableSessions.some((session) => session.id === activeSessionId)
            ? activeSessionId
            : (availableSessions[0]?.id ?? ""));
        if (next[terminal.id] !== currentID) changed = true;
      }
      return changed ? next : current;
    });
  }, [selectedID, activeSessionId, availableSessions]);

  function persist(next: Workflow[]) {
    try {
      saveWorkflows(next);
      setWorkflows(next);
      setNotice("");
      return true;
    } catch (error) {
      setNotice(`无法保存工作流：${String(error).replace(/^Error: /, "")}`);
      return false;
    }
  }

  function create() {
    const workflow = newWorkflow();
    const next = [...workflows, workflow];
    if (!persist(next)) return;
    setSelectedID(workflow.id);
    setDraft(workflow);
  }

  function beginEdit() {
    if (selected) {
      setDraft(structuredClone(selected));
      setNotice("");
    }
  }

  function saveDraft() {
    if (!draft) return;
    try {
      const nextWorkflow = validateWorkflow({
        ...draft,
        updatedAt: Date.now(),
      });
      const next = workflows.map((workflow) =>
        workflow.id === nextWorkflow.id ? nextWorkflow : workflow,
      );
      if (!persist(next)) return;
      setSelectedID(nextWorkflow.id);
      setSelectedStepID(nextWorkflow.steps[0]?.id ?? "");
      setRuntimeValues(
        Object.fromEntries(
          nextWorkflow.parameters.map((parameter) => [
            parameter.name,
            parameter.defaultValue,
          ]),
        ),
      );
      setRuntimeCommands({});
      setStepStatuses({});
      setDraft(null);
      setNotice("工作流已保存");
    } catch (error) {
      setNotice(String(error).replace(/^Error: /, ""));
    }
  }

  function removeSelected() {
    if (!selected) return;
    if (!window.confirm(`删除工作流“${selected.title}”？`)) return;
    markBuiltInDeleted(selected.id);
    const next = workflows.filter((workflow) => workflow.id !== selected.id);
    if (!persist(next)) return;
    setSelectedID(next[0]?.id ?? "");
    setDraft(null);
    setNotice("工作流已删除");
  }

  function downloadSelected() {
    if (!selected) return;
    const warnings = workflowSecretWarnings(selected);
    if (
      warnings.length &&
      !window.confirm(
        `工作流可能包含敏感信息：\n\n${warnings.join("\n")}\n\n仍要导出吗？`,
      )
    )
      return;
    const blob = new Blob([exportWorkflow(selected)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(selected.title)}.orbit-workflow.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file?: File) {
    if (!file) return;
    setImporting(true);
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error("工作流文件不能超过 5 MB");
      const imported = parseWorkflowFile(await file.text());
      const warnings = workflowSecretWarnings(imported);
      if (
        warnings.length &&
        !window.confirm(
          `导入文件可能包含敏感信息：\n\n${warnings.join("\n")}\n\n仍要导入吗？`,
        )
      )
        return;
      const workflow = workflows.some((item) => item.id === imported.id)
        ? { ...imported, id: crypto.randomUUID() }
        : imported;
      const next = [...workflows, workflow];
      if (!persist(next)) return;
      setSelectedID(workflow.id);
      setDraft(null);
      setNotice("已导入工作流。发送命令前请检查步骤和目标终端。");
    } catch (error) {
      setNotice(`导入失败：${String(error).replace(/^Error: /, "")}`);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function updateDraft(update: (workflow: Workflow) => Workflow) {
    setDraft((current) => (current ? update(current) : current));
  }

  function addParameter() {
    if (!draft) return;
    let index = draft.parameters.length + 1;
    let name = `param_${index}`;
    while (draft.parameters.some((parameter) => parameter.name === name)) {
      index += 1;
      name = `param_${index}`;
    }
    updateDraft((workflow) => ({
      ...workflow,
      parameters: [
        ...workflow.parameters,
        { name, label: "新参数", defaultValue: "", required: true },
      ],
    }));
  }

  function renameParameter(previousName: string, nextName: string) {
    const escapedName = previousName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const placeholder = new RegExp(`\\{\\{\\s*${escapedName}\\s*\\}\\}`, "g");
    updateDraft((workflow) => ({
      ...workflow,
      parameters: workflow.parameters.map((item) =>
        item.name === previousName ? { ...item, name: nextName } : item,
      ),
      steps: workflow.steps.map((step) => ({
        ...step,
        command: step.command.replace(placeholder, () => `{{${nextName}}}`),
      })),
    }));
  }

  function addTerminal() {
    const id = `target_${crypto.randomUUID().slice(0, 8)}`;
    updateDraft((workflow) => ({
      ...workflow,
      terminals: [...workflow.terminals, { id, label: "新终端" }],
    }));
  }

  function removeTerminal(terminalID: string) {
    if (!draft || draft.terminals.length <= 1) return;
    const terminals = draft.terminals.filter(
      (terminal) => terminal.id !== terminalID,
    );
    const fallbackID = terminals[0].id;
    updateDraft((workflow) => ({
      ...workflow,
      terminals,
      steps: workflow.steps.map((step) =>
        step.terminalId === terminalID
          ? { ...step, terminalId: fallbackID }
          : step,
      ),
    }));
  }

  function addStep() {
    if (!draft) return;
    const previous = draft.steps[draft.steps.length - 1];
    const step: WorkflowStep = {
      id: crypto.randomUUID(),
      title: `${
        draft.mode === "flat" ? "条目" : "步骤"
      } ${draft.steps.length + 1}`,
      description: "",
      command: "",
      terminalId: draft.terminals[0].id,
      optional: false,
      dependsOn:
        draft.mode === "flat" || !previous ? [] : [previous.id],
    };
    updateDraft((workflow) => ({
      ...workflow,
      steps: [...workflow.steps, step],
    }));
  }

  function moveStep(stepID: string, direction: -1 | 1) {
    if (!draft) return;
    const index = draft.steps.findIndex((step) => step.id === stepID);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    updateDraft((workflow) => ({ ...workflow, steps }));
  }

  function removeStep(stepID: string) {
    if (!draft || draft.steps.length <= 1) return;
    updateDraft((workflow) => ({
      ...workflow,
      steps: workflow.steps
        .filter((step) => step.id !== stepID)
        .map((step) => ({
          ...step,
          dependsOn: step.dependsOn.filter(
            (dependency) => dependency !== stepID,
          ),
        })),
    }));
  }

  // The library page edits the saved workflow directly instead of preparing a
  // run, so every change here is persisted right away.
  function updateSelected(update: (workflow: Workflow) => Workflow) {
    if (!selected) return false;
    return persist(
      workflows.map((workflow) =>
        workflow.id === selected.id ? update(workflow) : workflow,
      ),
    );
  }

  function beginStepEdit(step: WorkflowStep) {
    setEditingStepID(step.id);
    setStepTitleDraft(step.title);
    setStepCommandDraft(step.command);
    setNotice("");
  }

  function cancelStepEdit() {
    setEditingStepID(null);
    setStepTitleDraft("");
    setStepCommandDraft("");
  }

  function saveStepEdit() {
    if (!editingStepID) return;
    const title = stepTitleDraft.trim();
    if (!title) {
      setNotice("步骤标题不能为空。");
      return;
    }
    const stepID = editingStepID;
    const saved = updateSelected((workflow) =>
      updateStep(workflow, stepID, (step) => ({
        ...step,
        title,
        command: stepCommandDraft,
      })),
    );
    if (!saved) return;
    setRuntimeCommands((current) => {
      if (!(stepID in current)) return current;
      const next = { ...current };
      delete next[stepID];
      return next;
    });
    cancelStepEdit();
    setNotice("步骤已更新。");
  }

  function addWorkflowStep() {
    if (!selected) return;
    const previous = selected.steps[selected.steps.length - 1];
    const step: WorkflowStep = {
      id: crypto.randomUUID(),
      title: `${
        selected.mode === "flat" ? "条目" : "步骤"
      } ${selected.steps.length + 1}`,
      description: "",
      command: "",
      terminalId: selected.terminals[0]?.id ?? "main",
      optional: false,
      dependsOn:
        selected.mode === "flat" || !previous ? [] : [previous.id],
    };
    if (
      !updateSelected((workflow) => ({
        ...workflow,
        steps: [...workflow.steps, step],
      }))
    )
      return;
    setSelectedStepID(step.id);
    beginStepEdit(step);
    setNotice("已添加步骤，填写标题和命令后保存。");
  }

  function deleteWorkflowStep(stepID: string) {
    if (!selected) return;
    const noun = selected.mode === "flat" ? "条目" : "步骤";
    if (selected.steps.length <= 1) {
      setNotice(`工作流至少需要保留一个${noun}。`);
      return;
    }
    const step = selected.steps.find((item) => item.id === stepID);
    if (!step) return;
    if (
      !window.confirm(
        `删除${noun}“${step.title || "未命名"}”？此修改会直接保存到工作流。`,
      )
    )
      return;
    const remaining = selected.steps.filter((item) => item.id !== stepID);
    const saved = updateSelected((workflow) => ({
      ...workflow,
      steps: workflow.steps
        .filter((item) => item.id !== stepID)
        .map((item) => ({
          ...item,
          dependsOn: item.dependsOn.filter(
            (dependency) => dependency !== stepID,
          ),
        })),
    }));
    if (!saved) return;
    if (selectedStepID === stepID) setSelectedStepID(remaining[0]?.id ?? "");
    cancelStepEdit();
    setNotice("步骤已删除。");
  }

  function resolveCommand(step: WorkflowStep) {
    const template = runtimeCommands[step.id] ?? step.command;
    return renderWorkflowCommand(
      template,
      runtimeValues,
      selected?.parameters ?? [],
    );
  }

  function loadWorkflow(workflow: Workflow) {
    setSelectedID(workflow.id);
    setDraft(null);
    setNotice("");
  }

  function dependenciesNotComplete(step: WorkflowStep) {
    if (!selected) return [];
    return step.dependsOn
      .map((id) => selected.steps.find((candidate) => candidate.id === id))
      .filter(
        (dependency): dependency is WorkflowStep =>
          dependency !== undefined &&
          stepStatuses[dependency.id] !== "completed",
      );
  }

  async function executeStep(step: WorkflowStep, command: string) {
    const sessionID = sessionBindings[step.terminalId];
    if (
      !sessionID ||
      !availableSessions.some((session) => session.id === sessionID)
    ) {
      setNotice("请先为此步骤选择一个已连接的 SSH 终端。");
      return;
    }
    try {
      onRunCommand(sessionID, command);
      setStepStatuses((current) => ({ ...current, [step.id]: "sent" }));
      setConfirmStepID(null);
      setNotice("命令已发送。检查终端输出后，手动标记步骤结果。");
    } catch (error) {
      setStepStatuses((current) => ({ ...current, [step.id]: "failed" }));
      setNotice(`发送失败：${String(error).replace(/^Error: /, "")}`);
    }
  }

  const currentCommand =
    selectedStep && selectedStep.command
      ? (() => {
          try {
            return { value: resolveCommand(selectedStep), error: "" };
          } catch (error) {
            return { value: "", error: String(error).replace(/^Error: /, "") };
          }
        })()
      : { value: "", error: "" };
  const currentStatus = selectedStep
    ? (stepStatuses[selectedStep.id] ?? "pending")
    : "pending";
  const unmetDependencies = selectedStep
    ? dependenciesNotComplete(selectedStep)
    : [];
  const destructiveCommand = commandLooksDestructive(currentCommand.value);
  const requiresConfirmation =
    destructiveCommand || /[\r\n]/.test(currentCommand.value);
  const selectedTarget = selectedStep
    ? sessionBindings[selectedStep.terminalId]
    : "";

  function resolveStepCommand(step: WorkflowStep) {
    const template = runtimeCommands[step.id] ?? step.command;
    try {
      return renderWorkflowCommand(
        template,
        runtimeValues,
        selected?.parameters ?? [],
      );
    } catch {
      return template;
    }
  }

  async function copyStepCommand(step?: WorkflowStep) {
    const target = step ?? selectedStep;
    if (!target) return;
    const text = resolveStepCommand(target) || target.command;
    if (!text.trim()) {
      setNotice("此步骤没有命令可复制。");
      return;
    }
    try {
      await writeClipboard(text);
      setNotice("命令已复制到剪贴板。");
    } catch {
      setNotice("复制失败，请手动选择命令文本。");
    }
  }

  // The runner panel drives the execution; the library page only browses and
  // edits the saved definition, so each side gets its own action bar.
  function renderStepActions(step: WorkflowStep, workflow: Workflow) {
    if (panel) {
      return (
        <>
          <div className="workflow-step-actions">
            {step.command ? (
              <button
                className={`button ${requiresConfirmation && confirmStepID === step.id ? "danger" : "primary"} compact`}
                disabled={Boolean(currentCommand.error)}
                onClick={() => {
                  if (!requiresConfirmation) {
                    if (currentCommand.value)
                      void executeStep(step, currentCommand.value);
                    return;
                  }
                  if (confirmStepID !== step.id) {
                    setConfirmStepID(step.id);
                    return;
                  }
                  if (currentCommand.value)
                    void executeStep(step, currentCommand.value);
                }}
              >
                <Play size={14} />
                {requiresConfirmation
                  ? confirmStepID === step.id
                    ? "确认发送命令"
                    : "检查命令后确认"
                  : currentStatus === "pending" || currentStatus === "skipped"
                    ? "执行此步"
                    : "重跑此步"}
              </button>
            ) : (
              <button
                className="button primary compact"
                onClick={() =>
                  setStepStatuses((current) => ({
                    ...current,
                    [step.id]: "completed",
                  }))
                }
              >
                <Check size={14} />
                标记完成
              </button>
            )}
            {step.command && (
              <button
                className="button secondary compact"
                onClick={() =>
                  setStepStatuses((current) => ({
                    ...current,
                    [step.id]: "completed",
                  }))
                }
              >
                <Check size={14} />
                标记完成
              </button>
            )}
            <button
              className="button secondary compact"
              onClick={() => {
                setStepStatuses((current) => ({
                  ...current,
                  [step.id]: "skipped",
                }));
                setConfirmStepID(null);
              }}
            >
              <SkipForward size={14} />
              跳过
            </button>
            <button
              className="icon-button"
              title="标记失败"
              aria-label="标记失败"
              onClick={() =>
                setStepStatuses((current) => ({
                  ...current,
                  [step.id]: "failed",
                }))
              }
            >
              <CircleAlert size={15} />
            </button>
            {selectedTarget && (
              <button
                className="icon-button"
                title="查看终端"
                aria-label="查看所选终端"
                onClick={() => onViewTerminal(selectedTarget)}
              >
                <TerminalSquare size={16} />
              </button>
            )}
            {currentStatus !== "pending" && (
              <button
                className="icon-button"
                title="重置此步骤状态"
                aria-label="重置此步骤状态"
                onClick={() =>
                  setStepStatuses((current) => ({
                    ...current,
                    [step.id]: "pending",
                  }))
                }
              >
                <RotateCcw size={15} />
              </button>
            )}
          </div>
          <p className="workflow-step-footnote">
            命令发送后不会自动判定成功；查看终端输出，再手动记录结果。
          </p>
        </>
      );
    }
    return (
      <>
        <div className="workflow-step-actions">
          <button
            className="button secondary compact"
            onClick={() => void copyStepCommand()}
            disabled={!step.command.trim()}
          >
            <Copy size={14} />
            复制命令
          </button>
          <button
            className="button secondary compact"
            onClick={() =>
              editingStepID === step.id
                ? cancelStepEdit()
                : beginStepEdit(step)
            }
          >
            <Pencil size={14} />
            {editingStepID === step.id ? "取消编辑" : "编辑步骤"}
          </button>
          <button
            className="button danger compact"
            onClick={() => deleteWorkflowStep(step.id)}
            disabled={workflow.steps.length <= 1}
            title={
              workflow.steps.length <= 1
                ? "工作流至少需要保留一个步骤"
                : "删除此步"
            }
          >
            <Trash2 size={14} />
            删除此步
          </button>
        </div>
        <p className="workflow-step-footnote">
          这里编辑的是工作流定义，修改会立即保存；实际执行请用右上角「选择主机执行」。
        </p>
      </>
    );
  }

  return (
    <section
      className={`workflows-page ${panel ? "workflow-runner-panel" : ""}`}
      aria-label={panel ? "终端工作流" : "工作流"}
      hidden={hidden}
    >
      {panel ? (
        <header className="workflow-panel-heading">
          <div>
            <strong>工作流</strong>
            <Select
              ariaLabel="选择工作流"
              size="sm"
              className="workflow-panel-select"
              value={selected?.id ?? ""}
              placeholder="选择工作流"
              onChange={(id) => {
                const workflow = workflows.find((item) => item.id === id);
                if (workflow) loadWorkflow(workflow);
              }}
              options={workflows.map((workflow) => ({
                value: workflow.id,
                label: workflow.title,
                hint: `${workflow.steps.length} 步`,
              }))}
            />
            {selected?.mode === "flat" && (
              <small className="workflow-panel-mode">
                并列手册：条目顺序不限，按需挑一条执行
              </small>
            )}
          </div>
          <div>
            <button
              className="icon-button"
              title="关闭工作流面板"
              aria-label="关闭工作流面板"
              onClick={onClosePanel}
            >
              <X size={16} />
            </button>
          </div>
        </header>
      ) : (
        <header className="workflows-heading">
          <div>
            <h1>工作流</h1>
            <p>本机保存的可调整终端操作流程</p>
          </div>
          <div className="workflows-heading-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".json,.orbit-workflow.json,application/json"
              hidden
              onChange={(event) =>
                void importFile(event.currentTarget.files?.[0])
              }
            />
            <button
              className="button secondary compact"
              onClick={() => fileInput.current?.click()}
              disabled={importing}
            >
              <FileInput size={15} />
              导入
            </button>
            <button className="button primary compact" onClick={create}>
              <Plus size={15} />
              新建工作流
            </button>
          </div>
        </header>
      )}

      {notice && (
        <div className="workflow-notice" role="status">
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {panel && !selected && (
        <div className="workflow-panel-empty">
          <WorkflowIcon size={21} />
          <strong>
            {workflows.length ? "尚未选择工作流" : "没有已保存的工作流"}
          </strong>
          <span>
            {workflows.length
              ? "从上方下拉框选一个流程，即可在当前 SSH 主机上逐步执行。"
              : "先在工作流库中导入或创建一个工作流。"}
          </span>
        </div>
      )}

      {(!panel || selected) && (
        <div className={`workflow-layout ${panel ? "workflow-panel-layout" : ""}`}>
        {!panel && <aside className="workflow-library" aria-label="工作流列表">
          <div className="workflow-library-heading">
            <strong>本地工作流</strong>
            <span>{workflows.length}</span>
          </div>
          {workflows.map((workflow) => (
            <div className="workflow-library-row" key={workflow.id}>
              <button
                className={`workflow-library-item ${workflow.id === selectedID ? "selected" : ""}`}
                onClick={() => loadWorkflow(workflow)}
                aria-current={workflow.id === selectedID ? "page" : undefined}
              >
                <span className="workflow-library-icon">
                  <FileOutput size={16} />
                </span>
                <span className="workflow-library-copy">
                  <strong>{workflow.title}</strong>
                  <small>
                    {workflow.steps.length} 个
                    {workflow.mode === "flat" ? "条目" : "步骤"}
                    {isBuiltInWorkflow(workflow.id) && " · 内置"}
                  </small>
                </span>
              </button>
              <button
                className="icon-button workflow-library-execute"
                title={`选择主机执行：${workflow.title}`}
                aria-label={`选择主机执行：${workflow.title}`}
                onClick={() => onExecuteWorkflow?.(workflow)}
              >
                <Play size={15} />
              </button>
            </div>
          ))}
          {!workflows.length && (
            <div className="workflow-library-empty">导入或新建一个工作流</div>
          )}
        </aside>}

        {selected ? (
          <div className="workflow-detail">
            <header className="workflow-detail-heading">
              <div>
                <h2>
                  {selected.title}
                  <span className="workflow-mode-badge">
                    {workflowModeLabel(selected.mode)}
                  </span>
                </h2>
                <p>{selected.description || "尚未添加说明"}</p>
              </div>
              <div className="workflow-detail-actions">
                {!panel && (
                  <button
                    className="button primary compact"
                    onClick={() => onExecuteWorkflow?.(selected)}
                  >
                    <Play size={14} />
                    选择主机执行
                  </button>
                )}
                {!panel && (
                  <>
                    <button
                      className="icon-button"
                      title="导出工作流文件"
                      aria-label="导出工作流文件"
                      onClick={downloadSelected}
                    >
                      <Download size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title="编辑工作流"
                      aria-label="编辑工作流"
                      onClick={beginEdit}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger-icon"
                      title="删除工作流"
                      aria-label="删除工作流"
                      onClick={removeSelected}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </header>

            {draft ? (
              <div className="workflow-editor">
                <div className="workflow-editor-fields">
                  <label>
                    名称
                    <input
                      value={draft.title}
                      maxLength={160}
                      onChange={(event) => {
                        const title = event.currentTarget.value;
                        updateDraft((workflow) => ({
                          ...workflow,
                          title,
                        }));
                      }}
                    />
                  </label>
                  <label>
                    说明
                    <textarea
                      rows={2}
                      value={draft.description}
                      onChange={(event) => {
                        const description = event.currentTarget.value;
                        updateDraft((workflow) => ({
                          ...workflow,
                          description,
                        }));
                      }}
                    />
                  </label>
                </div>

                <section className="workflow-editor-section">
                  <div className="workflow-section-title">
                    <div>
                      <h3>执行方式</h3>
                      <p>{workflowModeHint(draft.mode)}</p>
                    </div>
                    <div className="workflow-editor-field">
                      <Select
                        ariaLabel="执行方式"
                        size="md"
                        value={draft.mode}
                        onChange={(value) =>
                          updateDraft((workflow) =>
                            setWorkflowMode(workflow, value as WorkflowMode),
                          )
                        }
                        options={[
                          { value: "flat", label: "并列手册" },
                          { value: "sequence", label: "按步骤流程" },
                        ]}
                      />
                    </div>
                  </div>
                  <p className="workflow-field-hint">
                    {draft.mode === "flat"
                      ? "所有条目同级，执行面板会一次列出全部条目，按需挑一条执行，顺序不限。"
                      : "步骤按编号推进，可以为每一步设置前置步骤；前置未完成只会提示，不会阻止执行。"}
                  </p>
                </section>

                <section className="workflow-editor-section">
                  <div className="workflow-section-title">
                    <h3>终端目标</h3>
                    <button className="text-button" onClick={addTerminal}>
                      <Plus size={14} />
                      添加目标
                    </button>
                  </div>
                  {draft.terminals.map((terminal) => (
                    <div className="workflow-editor-inline" key={terminal.id}>
                      <code>{terminal.id}</code>
                      <input
                        aria-label="终端目标名称"
                        value={terminal.label}
                        onChange={(event) => {
                          const label = event.currentTarget.value;
                          updateDraft((workflow) => ({
                            ...workflow,
                            terminals: workflow.terminals.map((item) =>
                              item.id === terminal.id
                                ? { ...item, label }
                                : item,
                            ),
                          }));
                        }}
                      />
                      <button
                        className="icon-button"
                        aria-label={`删除终端目标 ${terminal.label}`}
                        disabled={draft.terminals.length <= 1}
                        onClick={() => removeTerminal(terminal.id)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </section>

                <section className="workflow-editor-section">
                  <div className="workflow-section-title">
                    <h3>参数</h3>
                    <button className="text-button" onClick={addParameter}>
                      <Plus size={14} />
                      添加参数
                    </button>
                  </div>
                  {draft.parameters.map((parameter) => (
                    <div
                      className="workflow-parameter-editor"
                      key={parameter.name}
                    >
                      <label>
                        参数名
                        <input
                          value={parameter.name}
                          onChange={(event) =>
                            renameParameter(
                              parameter.name,
                              event.currentTarget.value,
                            )
                          }
                        />
                      </label>
                      <label>
                        显示名称
                        <input
                          value={parameter.label}
                          onChange={(event) => {
                            const label = event.currentTarget.value;
                            updateDraft((workflow) => ({
                              ...workflow,
                              parameters: workflow.parameters.map((item) =>
                                item.name === parameter.name
                                  ? { ...item, label }
                                  : item,
                              ),
                            }));
                          }}
                        />
                      </label>
                      <label>
                        默认值
                        <input
                          value={parameter.defaultValue}
                          onChange={(event) => {
                            const defaultValue = event.currentTarget.value;
                            updateDraft((workflow) => ({
                              ...workflow,
                              parameters: workflow.parameters.map((item) =>
                                item.name === parameter.name
                                  ? { ...item, defaultValue }
                                  : item,
                              ),
                            }));
                          }}
                        />
                      </label>
                      <label className="workflow-checkbox">
                        <input
                          type="checkbox"
                          checked={parameter.required}
                          onChange={(event) => {
                            const required = event.currentTarget.checked;
                            updateDraft((workflow) => ({
                              ...workflow,
                              parameters: workflow.parameters.map((item) =>
                                item.name === parameter.name
                                  ? { ...item, required }
                                  : item,
                              ),
                            }));
                          }}
                        />
                        必填
                      </label>
                      <button
                        className="icon-button"
                        aria-label={`删除参数 ${parameter.label}`}
                        onClick={() =>
                          updateDraft((workflow) => ({
                            ...workflow,
                            parameters: workflow.parameters.filter(
                              (item) => item.name !== parameter.name,
                            ),
                          }))
                        }
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                  <p className="workflow-field-hint">
                    在命令中使用 <code>{"{{参数名}}"}</code>。参数值会作为 POSIX
                    shell 单个参数自动引用，命令里不要再套引号。
                  </p>
                </section>

                <section className="workflow-editor-section">
                  <div className="workflow-section-title">
                    <h3>步骤</h3>
                    <button className="text-button" onClick={addStep}>
                      <Plus size={14} />
                      添加步骤
                    </button>
                  </div>
                  {draft.steps.map((step, index) => (
                    <article className="workflow-step-editor" key={step.id}>
                      <div className="workflow-step-editor-heading">
                        <strong>
                          {draft.mode === "flat" ? "条目" : "步骤"} {index + 1}
                        </strong>
                        <div>
                          <button
                            className="icon-button"
                            title="上移"
                            aria-label="上移步骤"
                            disabled={index === 0}
                            onClick={() => moveStep(step.id, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            className="icon-button"
                            title="下移"
                            aria-label="下移步骤"
                            disabled={index === draft.steps.length - 1}
                            onClick={() => moveStep(step.id, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            className="icon-button"
                            title="删除步骤"
                            aria-label="删除步骤"
                            disabled={draft.steps.length <= 1}
                            onClick={() => removeStep(step.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                      <div className="workflow-editor-fields two-columns">
                        <label>
                          标题
                          <input
                            value={step.title}
                            onChange={(event) => {
                              const title = event.currentTarget.value;
                              updateDraft((workflow) =>
                                updateStep(workflow, step.id, (item) => ({
                                  ...item,
                                  title,
                                })),
                              );
                            }}
                          />
                        </label>
                        <div className="workflow-editor-field">
                          <span>终端目标</span>
                          <Select
                            ariaLabel="终端目标"
                            size="md"
                            value={step.terminalId}
                            onChange={(value) =>
                              updateDraft((workflow) =>
                                updateStep(workflow, step.id, (item) => ({
                                  ...item,
                                  terminalId: value,
                                })),
                              )
                            }
                            options={draft.terminals.map((terminal) => ({
                              value: terminal.id,
                              label: terminal.label,
                            }))}
                          />
                        </div>
                      </div>
                      <label className="workflow-editor-label">
                        说明
                        <textarea
                          rows={2}
                          value={step.description}
                          onChange={(event) => {
                            const description = event.currentTarget.value;
                            updateDraft((workflow) =>
                              updateStep(workflow, step.id, (item) => ({
                                ...item,
                                description,
                              })),
                            );
                          }}
                        />
                      </label>
                      <label className="workflow-editor-label">
                        命令
                        <textarea
                          rows={3}
                          spellCheck={false}
                          value={step.command}
                          onChange={(event) => {
                            const command = event.currentTarget.value;
                            updateDraft((workflow) =>
                              updateStep(workflow, step.id, (item) => ({
                                ...item,
                                command,
                              })),
                            );
                          }}
                          placeholder="留空可创建人工确认步骤"
                        />
                      </label>
                      <label className="workflow-checkbox">
                        <input
                          type="checkbox"
                          checked={step.optional}
                          onChange={(event) => {
                            const optional = event.currentTarget.checked;
                            updateDraft((workflow) =>
                              updateStep(workflow, step.id, (item) => ({
                                ...item,
                                optional,
                              })),
                            );
                          }}
                        />
                        可跳过
                      </label>
                      {draft.mode === "sequence" && (
                        <details className="workflow-prerequisites">
                          <summary>前置步骤</summary>
                          <div>
                            {draft.steps
                              .filter((candidate) => candidate.id !== step.id)
                              .map((candidate) => (
                                <label
                                  className="workflow-checkbox"
                                  key={candidate.id}
                                >
                                  <input
                                    type="checkbox"
                                    checked={step.dependsOn.includes(
                                      candidate.id,
                                    )}
                                    onChange={(event) => {
                                      const checked = event.currentTarget.checked;
                                      updateDraft((workflow) =>
                                        updateStep(workflow, step.id, (item) => ({
                                          ...item,
                                          dependsOn: checked
                                            ? [...item.dependsOn, candidate.id]
                                            : item.dependsOn.filter(
                                                (id) => id !== candidate.id,
                                              ),
                                        })),
                                      );
                                    }}
                                  />
                                  {candidate.title}
                                </label>
                              ))}
                          </div>
                        </details>
                      )}
                    </article>
                  ))}
                </section>

                <footer className="workflow-editor-footer">
                  <button
                    className="button secondary compact"
                    onClick={() => setDraft(null)}
                  >
                    取消
                  </button>
                  <button
                    className="button primary compact"
                    onClick={saveDraft}
                  >
                    <Check size={15} />
                    保存工作流
                  </button>
                </footer>
              </div>
            ) : (
              <>
                <section
                  className="workflow-run-settings"
                  aria-label="本次运行设置"
                >
                  <div className="workflow-section-title">
                    <div>
                      <h3>本次运行</h3>
                      <p>参数修改只影响当前运行。</p>
                    </div>
                  </div>
                  <div className="workflow-runtime-grid">
                    {selected.parameters.map((parameter) => (
                      <label key={parameter.name}>
                        {parameter.label}
                        <input
                          value={runtimeValues[parameter.name] ?? ""}
                          aria-required={parameter.required}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setConfirmStepID(null);
                            setRuntimeValues((current) => ({
                              ...current,
                              [parameter.name]: value,
                            }));
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="workflow-target-grid">
                    {selected.terminals.map((terminal) => (
                      <div className="workflow-target-field" key={terminal.id}>
                        <span>{terminal.label}</span>
                        <Select
                          ariaLabel={terminal.label}
                          size="md"
                          value={sessionBindings[terminal.id] ?? ""}
                          onChange={(value) =>
                            (() => {
                              setConfirmStepID(null);
                              setSessionBindings((current) => ({
                                ...current,
                                [terminal.id]: value,
                              }));
                            })()
                          }
                          options={[
                            { value: "", label: "选择已连接的 SSH 终端" },
                            ...availableSessions.map((session) => ({
                              value: session.id,
                              label: terminalLabel(session),
                            })),
                            ...(sessionBindings[terminal.id] &&
                            !availableSessions.some(
                              (session) =>
                                session.id === sessionBindings[terminal.id],
                            )
                              ? [
                                  {
                                    value: sessionBindings[terminal.id],
                                    label: "终端已断开",
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                  {!availableSessions.length && (
                    <p className="workflow-field-hint">
                      请先连接 SSH 主机，再选择终端。命令不会在本地 Shell
                      或演示终端中运行。
                    </p>
                  )}
                </section>

                {selected.mode === "flat" ? (
                  panel ? (
                    <WorkflowManual
                      workflow={selected}
                      runtimeValues={runtimeValues}
                      runtimeCommands={runtimeCommands}
                      statuses={stepStatuses}
                      sessionBindings={sessionBindings}
                      onExecute={(step, command) =>
                        void executeStep(step, command)
                      }
                      onStatus={(stepID, status) =>
                        setStepStatuses((current) => ({
                          ...current,
                          [stepID]: status,
                        }))
                      }
                      onCommandOverride={(stepID, command) =>
                        setRuntimeCommands((current) => ({
                          ...current,
                          [stepID]: command,
                        }))
                      }
                      onViewTerminal={onViewTerminal}
                      onNotice={setNotice}
                    />
                  ) : (
                    <section
                      className="workflow-manual workflow-manual-library"
                      aria-label="工作流条目"
                    >
                      {selected.steps.map((step) => {
                        const editing = editingStepID === step.id;
                        const terminal = selected.terminals.find(
                          (item) => item.id === step.terminalId,
                        );
                        return (
                          <article
                            className="workflow-manual-entry"
                            key={step.id}
                          >
                            <header className="workflow-manual-entry-heading">
                              <span className="workflow-manual-entry-status">
                                <span className="workflow-step-dot" />
                              </span>
                              <div className="workflow-manual-entry-copy">
                                <h4>{step.title || "未命名条目"}</h4>
                                {step.description && <p>{step.description}</p>}
                              </div>
                              <span className="workflow-manual-entry-terminal">
                                {terminal?.label ?? "未指定终端"}
                              </span>
                            </header>
                            {editing ? (
                              <div className="workflow-step-edit">
                                <label className="workflow-step-edit-field">
                                  <span>标题</span>
                                  <input
                                    value={stepTitleDraft}
                                    maxLength={160}
                                    onChange={(event) =>
                                      setStepTitleDraft(
                                        event.currentTarget.value,
                                      )
                                    }
                                  />
                                </label>
                                <label className="workflow-step-edit-field">
                                  <span>命令模板</span>
                                  <textarea
                                    className="workflow-command-editor"
                                    rows={3}
                                    spellCheck={false}
                                    value={stepCommandDraft}
                                    placeholder="留空表示由你手动完成这一条"
                                    onChange={(event) =>
                                      setStepCommandDraft(
                                        event.currentTarget.value,
                                      )
                                    }
                                  />
                                </label>
                                <p className="workflow-field-hint">
                                  命令中的 <code>{"{{参数名}}"}</code>{" "}
                                  会在执行前替换为参数值。保存后会直接写入工作流。
                                </p>
                                <div className="workflow-step-edit-actions">
                                  <button
                                    className="button secondary compact"
                                    onClick={cancelStepEdit}
                                  >
                                    取消
                                  </button>
                                  <button
                                    className="button primary compact"
                                    onClick={saveStepEdit}
                                  >
                                    <Check size={14} />
                                    保存条目
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <pre className="workflow-command-preview">
                                {step.command ||
                                  "此条目没有命令，由你手动完成。"}
                              </pre>
                            )}
                            <div className="workflow-manual-entry-actions">
                              <button
                                className="button secondary compact"
                                onClick={() => void copyStepCommand(step)}
                                disabled={!step.command.trim()}
                              >
                                <Copy size={14} />
                                复制命令
                              </button>
                              <button
                                className="button secondary compact"
                                onClick={() =>
                                  editing ? cancelStepEdit() : beginStepEdit(step)
                                }
                              >
                                <Pencil size={14} />
                                {editing ? "取消编辑" : "编辑条目"}
                              </button>
                              <button
                                className="button danger compact"
                                onClick={() => deleteWorkflowStep(step.id)}
                                disabled={selected.steps.length <= 1}
                                title={
                                  selected.steps.length <= 1
                                    ? "工作流至少需要保留一个条目"
                                    : "删除此条"
                                }
                              >
                                <Trash2 size={14} />
                                删除此条
                              </button>
                            </div>
                          </article>
                        );
                      })}
                      <button
                        className="workflow-step-add"
                        onClick={addWorkflowStep}
                      >
                        <Plus size={14} />
                        添加条目
                      </button>
                    </section>
                  )
                ) : (
                  <div className="workflow-run-layout">
                  <nav className="workflow-step-list" aria-label="工作流步骤">
                    {selected.steps.map((step, index) => {
                      const status = stepStatuses[step.id] ?? "pending";
                      return (
                        <button
                          className={`workflow-step-list-item ${selectedStepID === step.id ? "selected" : ""} status-${status}`}
                          key={step.id}
                          onClick={() => {
                            setSelectedStepID(step.id);
                            setConfirmStepID(null);
                            if (editingStepID !== step.id) cancelStepEdit();
                          }}
                        >
                          {selected.mode === "flat" ? (
                            <span className="workflow-step-dot" />
                          ) : (
                            <span className="workflow-step-index">
                              {index + 1}
                            </span>
                          )}
                          <span className="workflow-step-list-copy">
                            <strong>
                              {step.title ||
                                (selected.mode === "flat"
                                  ? `条目 ${index + 1}`
                                  : `步骤 ${index + 1}`)}
                            </strong>
                            <small>
                              {panel
                                ? statusText[status]
                                : (selected.terminals.find(
                                    (item) => item.id === step.terminalId,
                                  )?.label ?? "未指定终端")}
                            </small>
                          </span>
                          {panel && statusIcon(status)}
                        </button>
                      );
                    })}
                    {!panel && (
                      <button
                        className="workflow-step-add"
                        onClick={addWorkflowStep}
                      >
                        <Plus size={14} />
                        添加步骤
                      </button>
                    )}
                  </nav>

                  {selectedStep ? (
                    <section
                      className="workflow-step-detail"
                      aria-label="步骤详情"
                    >
                      <header>
                        <div>
                          <span className="workflow-step-kicker">
                            步骤{" "}
                            {selected.steps.findIndex(
                              (step) => step.id === selectedStep.id,
                            ) + 1}
                            {selectedStep.optional ? " · 可跳过" : ""}
                          </span>
                          <h3>{selectedStep.title}</h3>
                          <p>{selectedStep.description || "没有步骤说明"}</p>
                        </div>
                        {panel && (
                          <span
                            className={`workflow-status status-${currentStatus}`}
                          >
                            {statusIcon(currentStatus)}
                            {statusText[currentStatus]}
                          </span>
                        )}
                      </header>

                      {panel && unmetDependencies.length > 0 && (
                        <div className="workflow-warning">
                          <CircleAlert size={16} />
                          <span>
                            前置步骤尚未标记完成：
                            {unmetDependencies
                              .map((step) => step.title)
                              .join("、")}
                            。仍可跳转执行。
                          </span>
                        </div>
                      )}

                      {selectedStep.command || !panel ? (
                        <div className="workflow-command-block">
                          <div className="workflow-command-heading">
                            <span>
                              {panel ? "发送到" : "终端目标"}{" "}
                              {
                                selected.terminals.find(
                                  (item) => item.id === selectedStep.terminalId,
                                )?.label
                              }
                            </span>
                            <div className="workflow-command-heading-actions">
                              <button
                                className="text-button"
                                onClick={() => void copyStepCommand()}
                                disabled={!selectedStep.command.trim()}
                              >
                                <Copy size={13} />
                                复制
                              </button>
                              {panel && (
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setEditingCommandID((current) =>
                                      current === selectedStep.id
                                        ? null
                                        : selectedStep.id,
                                    );
                                    setConfirmStepID(null);
                                  }}
                                >
                                  <Pencil size={13} />
                                  {editingCommandID === selectedStep.id
                                    ? "完成调整"
                                    : "调整本次命令"}
                                </button>
                              )}
                            </div>
                          </div>
                          {!panel && editingStepID === selectedStep.id ? (
                            <div className="workflow-step-edit">
                              <label className="workflow-step-edit-field">
                                <span>标题</span>
                                <input
                                  value={stepTitleDraft}
                                  maxLength={160}
                                  onChange={(event) =>
                                    setStepTitleDraft(event.currentTarget.value)
                                  }
                                />
                              </label>
                              <label className="workflow-step-edit-field">
                                <span>命令模板</span>
                                <textarea
                                  className="workflow-command-editor"
                                  rows={4}
                                  spellCheck={false}
                                  value={stepCommandDraft}
                                  placeholder="留空表示由你手动完成这一步"
                                  onChange={(event) =>
                                    setStepCommandDraft(
                                      event.currentTarget.value,
                                    )
                                  }
                                />
                              </label>
                              <p className="workflow-field-hint">
                                命令中的 <code>{"{{参数名}}"}</code>{" "}
                                会在执行前替换为参数值。保存后会直接写入工作流。
                              </p>
                              <div className="workflow-step-edit-actions">
                                <button
                                  className="button secondary compact"
                                  onClick={cancelStepEdit}
                                >
                                  取消
                                </button>
                                <button
                                  className="button primary compact"
                                  onClick={saveStepEdit}
                                >
                                  <Check size={14} />
                                  保存步骤
                                </button>
                              </div>
                            </div>
                          ) : panel && editingCommandID === selectedStep.id ? (
                            <textarea
                              className="workflow-command-editor"
                              rows={4}
                              spellCheck={false}
                              value={
                                runtimeCommands[selectedStep.id] ??
                                selectedStep.command
                              }
                              onChange={(event) =>
                                (() => {
                                  setConfirmStepID(null);
                                  setRuntimeCommands((current) => ({
                                    ...current,
                                    [selectedStep.id]:
                                      event.currentTarget.value,
                                  }));
                                })()
                              }
                            />
                          ) : (
                            <pre className="workflow-command-preview">
                              {currentCommand.value ||
                                currentCommand.error ||
                                selectedStep.command ||
                                "此步骤没有命令，由你手动完成。"}
                            </pre>
                          )}
                          {currentCommand.error && (
                            <p className="workflow-error">
                              {currentCommand.error}
                            </p>
                          )}
                          {requiresConfirmation && (
                            <div className="workflow-warning destructive">
                              <CircleAlert size={16} />
                              <span>
                                {destructiveCommand
                                  ? "此命令可能重启、停止或删除服务。核对目标终端和完整命令后再次确认。"
                                  : "此命令包含多行内容，可能连续执行多条命令。核对目标终端和完整命令后再次确认。"}
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="workflow-manual-step">
                          <span>此步骤由你手动完成。</span>
                        </div>
                      )}

                      {renderStepActions(selectedStep, selected)}
                    </section>
                  ) : (
                    <div className="workflow-step-detail workflow-empty-step">
                      <ListPlus size={22} />
                      <span>选择一个步骤查看命令和运行状态</span>
                    </div>
                  )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="workflow-empty-detail">
            <FileOutput size={28} />
            <strong>
              {panel
                ? workflows.length
                  ? "尚未加载工作流"
                  : "没有已保存的工作流"
                : "还没有工作流"}
            </strong>
            {!panel && <p>新建工作流，或从文件导入一条流程。</p>}
            {!panel && (
              <button className="button primary compact" onClick={create}>
                <Plus size={15} />
                新建工作流
              </button>
            )}
          </div>
        )}
        </div>
      )}
    </section>
  );
}
