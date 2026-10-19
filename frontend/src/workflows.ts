export const workflowFormat = "orbitssh.workflow";
export const workflowSchemaVersion = 1;

export interface WorkflowParameter {
  name: string;
  label: string;
  defaultValue: string;
  required: boolean;
}

export interface WorkflowTerminal {
  id: string;
  label: string;
}

export interface WorkflowStep {
  id: string;
  title: string;
  description: string;
  command: string;
  terminalId: string;
  optional: boolean;
  dependsOn: string[];
}

export interface Workflow {
  format: typeof workflowFormat;
  schemaVersion: number;
  id: string;
  title: string;
  description: string;
  parameters: WorkflowParameter[];
  terminals: WorkflowTerminal[];
  steps: WorkflowStep[];
  updatedAt: number;
}

const storageKey = "orbit-ssh-workflows-v1";
const workflowsUpdatedEvent = "orbitssh:workflows-updated";
const nginxWorkflowID = "orbitssh-nginx-maintenance-v1";
const workflowFileMaxBytes = 5 * 1024 * 1024;

export const nginxWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: nginxWorkflowID,
  title: "检查并更新 Nginx 配置",
  description:
    "查看当前配置、编辑指定文件、验证语法并重启服务。编辑配置后再继续；每条命令都需要单独发送。",
  parameters: [
    {
      name: "config_path",
      label: "要编辑的配置文件",
      defaultValue: "/etc/nginx/nginx.conf",
      required: true,
    },
    {
      name: "service_name",
      label: "服务名称",
      defaultValue: "nginx",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "Nginx 服务器" }],
  steps: [
    {
      id: "nginx-check-before",
      title: "检查当前配置",
      description: "记录修改前的语法检查结果。",
      command: "sudo nginx -t",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
    {
      id: "nginx-inspect",
      title: "查看已加载的配置",
      description:
        "列出 Nginx 主配置及 include 文件。输出可能包含服务器路径或敏感配置。",
      command: "sudo nginx -T",
      terminalId: "main",
      optional: false,
      dependsOn: [],
    },
    {
      id: "nginx-edit",
      title: "编辑配置文件",
      description:
        "在编辑器中修改目标文件，保存并退出后，再手动标记此步骤完成。",
      command: "sudoedit {{config_path}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["nginx-inspect"],
    },
    {
      id: "nginx-validate",
      title: "验证修改后的配置",
      description: "语法检查通过后再继续重启。",
      command: "sudo nginx -t",
      terminalId: "main",
      optional: false,
      dependsOn: ["nginx-edit"],
    },
    {
      id: "nginx-restart",
      title: "重启 Nginx",
      description: "确认目標主机和配置检查结果后重启服务；这可能短暂中断连接。",
      command: "sudo systemctl restart {{service_name}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["nginx-validate"],
    },
    {
      id: "nginx-verify",
      title: "确认服务状态",
      description: "检查服务是否处于 active 状态。",
      command: "sudo systemctl is-active {{service_name}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["nginx-restart"],
    },
  ],
  updatedAt: Date.now(),
};

export function newWorkflow(): Workflow {
  const now = Date.now();
  return {
    format: workflowFormat,
    schemaVersion: workflowSchemaVersion,
    id: crypto.randomUUID(),
    title: "新建工作流",
    description: "",
    parameters: [],
    terminals: [{ id: "main", label: "默认终端" }],
    steps: [
      {
        id: crypto.randomUUID(),
        title: "新步骤",
        description: "",
        command: "",
        terminalId: "main",
        optional: false,
        dependsOn: [],
      },
    ],
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkflow(value: unknown): Workflow {
  if (!isRecord(value) || value.format !== workflowFormat)
    throw new Error("文件不是 Orbit SSH 工作流");
  if (value.schemaVersion !== workflowSchemaVersion)
    throw new Error("工作流版本暂不受支持");
  if (
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.length > 128 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.description !== "string" ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.terminals) ||
    !Array.isArray(value.steps)
  )
    throw new Error("工作流文件缺少必要字段");
  if (
    value.title.length > 160 ||
    value.description.length > 4000 ||
    value.parameters.length > 50 ||
    value.terminals.length < 1 ||
    value.terminals.length > 20 ||
    value.steps.length < 1 ||
    value.steps.length > 100
  )
    throw new Error("工作流内容超出允许范围");

  const terminals = value.terminals.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
      typeof item.label !== "string" ||
      item.label.length > 120
    )
      throw new Error("工作流包含无效的终端目标");
    return { id: item.id, label: item.label };
  });
  const terminalIDs = new Set(terminals.map((terminal) => terminal.id));
  if (terminalIDs.size !== terminals.length)
    throw new Error("工作流中的终端目标 ID 重复");

  const parameters = value.parameters.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.name) ||
      typeof item.label !== "string" ||
      typeof item.defaultValue !== "string" ||
      typeof item.required !== "boolean" ||
      item.label.length > 120 ||
      item.defaultValue.length > 2000
    )
      throw new Error("工作流包含无效参数");
    return {
      name: item.name,
      label: item.label,
      defaultValue: item.defaultValue,
      required: item.required,
    };
  });
  if (
    new Set(parameters.map((parameter) => parameter.name)).size !==
    parameters.length
  )
    throw new Error("工作流参数名称重复");

  const steps = value.steps.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.title !== "string" ||
      typeof item.description !== "string" ||
      typeof item.command !== "string" ||
      typeof item.terminalId !== "string" ||
      typeof item.optional !== "boolean" ||
      !Array.isArray(item.dependsOn) ||
      item.dependsOn.some((dependency) => typeof dependency !== "string") ||
      item.title.length > 160 ||
      item.description.length > 2000 ||
      item.command.length > 20000 ||
      !terminalIDs.has(item.terminalId)
    )
      throw new Error("工作流包含无效步骤");
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      command: item.command,
      terminalId: item.terminalId,
      optional: item.optional,
      dependsOn: item.dependsOn as string[],
    };
  });
  const stepIDs = new Set(steps.map((step) => step.id));
  if (stepIDs.size !== steps.length) throw new Error("工作流步骤 ID 重复");
  for (const step of steps) {
    if (
      step.dependsOn.some(
        (dependency) => !stepIDs.has(dependency) || dependency === step.id,
      )
    )
      throw new Error(`步骤“${step.title}”包含无效前置步骤`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stepsByID = new Map(steps.map((step) => [step.id, step]));
  function visit(stepID: string) {
    if (visited.has(stepID)) return;
    if (visiting.has(stepID)) throw new Error("工作流步骤前置条件存在循环");
    visiting.add(stepID);
    for (const dependency of stepsByID.get(stepID)?.dependsOn ?? [])
      visit(dependency);
    visiting.delete(stepID);
    visited.add(stepID);
  }
  for (const step of steps) visit(step.id);

  return {
    format: workflowFormat,
    schemaVersion: workflowSchemaVersion,
    id: value.id,
    title: value.title,
    description: value.description,
    parameters,
    terminals,
    steps,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  };
}

export function loadWorkflows(): Workflow[] {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null) return [nginxWorkflow];
    const decoded: unknown = JSON.parse(stored);
    if (!Array.isArray(decoded)) return [];
    return decoded.map(validateWorkflow);
  } catch {
    return [nginxWorkflow];
  }
}

export function saveWorkflows(workflows: Workflow[]) {
  localStorage.setItem(storageKey, JSON.stringify(workflows));
  window.dispatchEvent(new Event(workflowsUpdatedEvent));
}

export function subscribeWorkflowsUpdated(listener: () => void) {
  window.addEventListener(workflowsUpdatedEvent, listener);
  return () => window.removeEventListener(workflowsUpdatedEvent, listener);
}

export function parseWorkflowFile(text: string): Workflow {
  if (text.length > workflowFileMaxBytes)
    throw new Error("工作流文件不能超过 5 MB");
  return validateWorkflow(JSON.parse(text) as unknown);
}

export function exportWorkflow(workflow: Workflow): string {
  return `${JSON.stringify(validateWorkflow(workflow), null, 2)}\n`;
}

export function workflowSecretWarnings(workflow: Workflow) {
  const warnings: string[] = [];
  for (const parameter of workflow.parameters) {
    if (
      parameter.defaultValue.trim() &&
      /password|passphrase|secret|token|credential|private.?key|api.?key/i.test(
        `${parameter.name} ${parameter.label}`,
      )
    )
      warnings.push(`参数“${parameter.label}”的默认值可能是凭据`);
  }
  if (
    workflow.steps.some((step) =>
      /(?:password|passphrase|secret|token|api[_ -]?key)\s*[:=]\s*[^\s]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Authorization:\s*Basic\s+\S+/i.test(
        step.command,
      ),
    )
  )
    warnings.push("命令中可能直接包含了密钥或认证信息");
  return warnings;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderWorkflowCommand(
  template: string,
  values: Record<string, string>,
  parameters: WorkflowParameter[],
) {
  const parameterMap = new Map(
    parameters.map((parameter) => [parameter.name, parameter]),
  );
  return template.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g,
    (_, name: string) => {
      const parameter = parameterMap.get(name);
      if (!parameter) throw new Error(`没有定义参数：${name}`);
      const value = Object.hasOwn(values, name) ? values[name] : "";
      if (parameter.required && !value.trim())
        throw new Error(`请填写“${parameter.label}”`);
      if (/[\u0000-\u001f\u007f]/.test(value))
        throw new Error(`参数“${parameter.label}”不能包含控制字符`);
      return shellQuote(value);
    },
  );
}

export function commandLooksDestructive(command: string) {
  return /(^|[;&|\s])(rm\s+-|mkfs(?:\.|\s)|shutdown\b|reboot\b|systemctl\s+(?:restart|stop|disable)\b|service\s+\S+\s+(?:restart|stop)\b|kill\s+-9\b)/i.test(
    command,
  );
}
