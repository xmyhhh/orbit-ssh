export const workflowFormat = "orbitssh.workflow";
export const workflowSchemaVersion = 2;
export const legacyWorkflowSchemaVersion = 1;

/**
 * A workflow is either a manual ("flat": sibling entries that can be run in
 * any order) or a procedure ("sequence": numbered steps with prerequisites).
 */
export type WorkflowMode = "flat" | "sequence";

export type StepStatus = "pending" | "sent" | "completed" | "failed" | "skipped";

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
  mode: WorkflowMode;
  parameters: WorkflowParameter[];
  terminals: WorkflowTerminal[];
  steps: WorkflowStep[];
  updatedAt: number;
}

const storageKey = "orbit-ssh-workflows-v1";
const deletedBuiltInsKey = "orbit-ssh-workflows-deleted-v1";
const workflowsUpdatedEvent = "orbitssh:workflows-updated";
const nginxWorkflowID = "orbitssh-nginx-maintenance-v1";
const workflowFileMaxBytes = 5 * 1024 * 1024;

export const nginxWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: nginxWorkflowID,
  mode: "sequence",
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

export const diskCleanupWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: "orbitssh-disk-cleanup-v1",
  mode: "sequence",
  title: "磁盘空间清理与日志轮转",
  description:
    "先排查占空间的目录，再清理过期日志、轮转压缩，最后复查磁盘水位。清理动作不可撤销，执行前请确认路径。",
  parameters: [
    {
      name: "mount_point",
      label: "要检查的挂载点",
      defaultValue: "/",
      required: true,
    },
    {
      name: "keep_days",
      label: "日志保留天数",
      defaultValue: "7",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "目标服务器" }],
  steps: [
    {
      id: "disk-usage",
      title: "查看磁盘水位",
      description: "先确认分区剩余空间，避免在满盘状态下做清理。",
      command: "df -h {{mount_point}}",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
    {
      id: "disk-large-dirs",
      title: "定位占空间的目录",
      description: "列出挂载点下最占空间的目录，判断该清理什么。",
      command:
        "sudo du -xh --max-depth=1 {{mount_point}} 2>/dev/null | sort -rh | head -20",
      terminalId: "main",
      optional: false,
      dependsOn: ["disk-usage"],
    },
    {
      id: "disk-old-logs",
      title: "删除过期日志文件",
      description: "删除超过保留天数的 .log 文件；不可撤销，执行前请确认。",
      command:
        "sudo find /var/log -type f -name '*.log' -mtime +{{keep_days}} -print -delete",
      terminalId: "main",
      optional: false,
      dependsOn: ["disk-large-dirs"],
    },
    {
      id: "disk-rotate",
      title: "轮转并压缩日志",
      description: "强制执行 logrotate，释放已归档日志占用的空间。",
      command: "sudo logrotate -f /etc/logrotate.conf",
      terminalId: "main",
      optional: true,
      dependsOn: ["disk-old-logs"],
    },
    {
      id: "disk-recheck",
      title: "复查磁盘水位",
      description: "对比清理前后的剩余空间，确认效果。",
      command: "df -h {{mount_point}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["disk-rotate"],
    },
  ],
  updatedAt: Date.now(),
};

export const serviceHealthWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: "orbitssh-service-health-v1",
  mode: "sequence",
  title: "服务健康巡检",
  description:
    "只读巡检：确认服务是否在运行、最近有没有错误日志、监听了哪些端口、谁在吃资源。全程不修改系统。",
  parameters: [
    {
      name: "service_name",
      label: "服务名称",
      defaultValue: "nginx",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "目标服务器" }],
  steps: [
    {
      id: "health-status",
      title: "确认服务状态",
      description: "查看服务是否处于 active 状态以及运行时长。",
      command: "systemctl status {{service_name}} --no-pager",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
    {
      id: "health-errors",
      title: "翻查最近一小时错误",
      description: "只筛选 error 及以上级别；输出可能包含内部路径。",
      command:
        "sudo journalctl -u {{service_name}} --since '-1 hour' --no-pager -p err",
      terminalId: "main",
      optional: false,
      dependsOn: ["health-status"],
    },
    {
      id: "health-ports",
      title: "查看监听端口",
      description: "确认服务实际监听的地址和端口。",
      command: "sudo ss -tlnp | grep {{service_name}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["health-status"],
    },
    {
      id: "health-resources",
      title: "查看资源占用排名",
      description: "找出 CPU 占用最高的进程，判断是否需要扩容。",
      command: "ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -10",
      terminalId: "main",
      optional: true,
      dependsOn: ["health-status"],
    },
  ],
  updatedAt: Date.now(),
};

export const dockerMaintenanceWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: "orbitssh-docker-maintenance-v1",
  mode: "sequence",
  title: "Docker 容器维护",
  description:
    "清理悬空镜像和已停止的容器，再重启指定容器并确认状态。清理会真正删除对象，执行前请确认。",
  parameters: [
    {
      name: "container_name",
      label: "要维护的容器名",
      defaultValue: "app",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "目标服务器" }],
  steps: [
    {
      id: "docker-list",
      title: "列出全部容器",
      description: "先看清楚有哪些容器以及它们的状态。",
      command: "docker ps -a --no-trunc",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
    {
      id: "docker-logs",
      title: "查看容器最近日志",
      description: "读取最后 100 行，判断是否有异常。",
      command: "docker logs --tail 100 {{container_name}} 2>&1",
      terminalId: "main",
      optional: false,
      dependsOn: ["docker-list"],
    },
    {
      id: "docker-prune-images",
      title: "清理悬空镜像",
      description: "删除没有标签的悬空镜像，会释放磁盘空间。",
      command: "docker image prune -f",
      terminalId: "main",
      optional: true,
      dependsOn: ["docker-list"],
    },
    {
      id: "docker-prune-containers",
      title: "清理已停止的容器",
      description: "删除所有已退出的容器；其日志会一并丢失。",
      command: "docker container prune -f",
      terminalId: "main",
      optional: false,
      dependsOn: ["docker-prune-images"],
    },
    {
      id: "docker-restart",
      title: "重启目标容器",
      description: "重启指定容器，短暂中断该服务。",
      command: "docker restart {{container_name}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["docker-prune-containers"],
    },
    {
      id: "docker-verify",
      title: "确认容器已恢复",
      description: "检查重启后的容器状态。",
      command: "docker ps --filter name={{container_name}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["docker-restart"],
    },
  ],
  updatedAt: Date.now(),
};

export const tlsCertificateWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: "orbitssh-tls-certificate-v1",
  mode: "sequence",
  title: "TLS 证书与跳转检查",
  description:
    "只读检查线上证书的有效期、签发者和 HTTP 到 HTTPS 的跳转情况，用来判断证书是否快到期。",
  parameters: [
    {
      name: "domain",
      label: "域名",
      defaultValue: "example.com",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "目标服务器" }],
  steps: [
    {
      id: "tls-dates",
      title: "查看证书有效期",
      description: "输出 notBefore 与 notAfter，据此判断是否需要续期。",
      command:
        "echo | openssl s_client -servername {{domain}} -connect {{domain}}:443 2>/dev/null | openssl x509 -noout -dates",
      terminalId: "main",
      optional: false,
      dependsOn: [],
    },
    {
      id: "tls-issuer",
      title: "查看签发者与证书主体",
      description: "确认证书签发机构以及域名是否匹配。",
      command:
        "echo | openssl s_client -servername {{domain}} -connect {{domain}}:443 2>/dev/null | openssl x509 -noout -issuer -subject",
      terminalId: "main",
      optional: false,
      dependsOn: ["tls-dates"],
    },
    {
      id: "tls-redirect",
      title: "检查 HTTP 跳转",
      description: "确认 80 端口会 301/302 到 HTTPS。",
      command:
        "curl -sI -o /dev/null -w '%{http_code} %{redirect_url}\\n' http://{{domain}}/",
      terminalId: "main",
      optional: false,
      dependsOn: ["tls-issuer"],
    },
    {
      id: "tls-https",
      title: "确认 HTTPS 可访问",
      description: "返回状态码，200 表示链路正常。",
      command: "curl -sI -o /dev/null -w '%{http_code}\\n' https://{{domain}}/",
      terminalId: "main",
      optional: false,
      dependsOn: ["tls-redirect"],
    },
  ],
  updatedAt: Date.now(),
};

export const systemUpdateWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: "orbitssh-system-update-v1",
  mode: "sequence",
  title: "系统更新与重启",
  description:
    "拉取更新包并升级系统，升级完成后按需重启。最后一步会断开连接，需要重新连回。",
  parameters: [
    {
      name: "reboot_command",
      label: "重启命令",
      defaultValue: "sudo reboot",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "目标服务器" }],
  steps: [
    {
      id: "update-check",
      title: "查看可用更新",
      description: "刷新软件源并列出可升级的软件包。",
      command:
        "sudo apt-get update -y && apt-get list --upgradable 2>/dev/null | tail -20",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
    {
      id: "update-apply",
      title: "安装更新",
      description: "升级全部软件包，过程中会重启部分服务。",
      command: "sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y",
      terminalId: "main",
      optional: false,
      dependsOn: ["update-check"],
    },
    {
      id: "update-reboot",
      title: "重启服务器",
      description: "重启会立刻断开当前连接，请确认没有其他任务在跑。",
      command: "{{reboot_command}}",
      terminalId: "main",
      optional: false,
      dependsOn: ["update-apply"],
    },
    {
      id: "update-verify",
      title: "重启后确认",
      description: "重新连上后执行，确认内核版本和运行时间。",
      command: "uname -r && uptime",
      terminalId: "main",
      optional: false,
      dependsOn: ["update-reboot"],
    },
  ],
  updatedAt: Date.now(),
};

export const connectionStatsWorkflow: Workflow = {
  format: workflowFormat,
  schemaVersion: workflowSchemaVersion,
  id: "orbitssh-connection-stats-v1",
  mode: "flat",
  title: "端口连接统计",
  description:
    "只读统计某个本地监听端口的 TCP 连接。各条目彼此独立，按需要挑一条执行即可，顺序不限：查看连接明细、按状态分类、统计 Top 对端 IP、统计全部状态连接数，或持续刷新已建立连接数。所有命令只读取连接状态，不会修改系统。",
  parameters: [
    {
      name: "port",
      label: "要统计的本地端口",
      defaultValue: "4080",
      required: true,
    },
  ],
  terminals: [{ id: "main", label: "目标服务器" }],
  steps: [
    {
      id: "conn-detail",
      title: "查看当前连接明细",
      description:
        "列出该端口上已建立的连接及对端地址；普通用户看不到进程名，需要 root 权限。",
      command: "ss -tnp state established '( sport = :{{port}} )'",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
    {
      id: "conn-by-state",
      title: "按状态分类统计",
      description:
        "按 TCP 状态统计连接数量；命令会跳过输出的第一行，所以首个连接不计入。",
      command:
        "ss -Htan '( sport = :{{port}} )' | awk 'NR>1{c[$1]++} END{for(k in c) print k, c[k]}'",
      terminalId: "main",
      optional: false,
      dependsOn: [],
    },
    {
      id: "conn-top-peers",
      title: "Top 对端 IP",
      description: "按已建立连接数排序，列出前 20 个对端 IP 及其连接数。",
      command:
        "ss -Htn state established '( sport = :{{port}} )' | awk '{print $4}' | cut -d: -f1 | sort | uniq -c | sort -rn | head -20",
      terminalId: "main",
      optional: false,
      dependsOn: [],
    },
    {
      id: "conn-all-states",
      title: "全部状态连接数",
      description:
        "统计该端口上所有状态的连接数量，包含 TIME-WAIT 和 CLOSE-WAIT。",
      command: "ss -Htan '( sport = :{{port}} )' | wc -l",
      terminalId: "main",
      optional: false,
      dependsOn: [],
    },
    {
      id: "conn-watch",
      title: "实时刷新已建立连接数",
      description:
        "每秒刷新一次已建立连接数。该命令会一直占用终端，需要按 Ctrl+C 才能继续。",
      command:
        "watch -n 1 'ss -Htn state established \"( sport = :{{port}} )\" | wc -l'",
      terminalId: "main",
      optional: true,
      dependsOn: [],
    },
  ],
  updatedAt: Date.now(),
};

export const builtInWorkflows: Workflow[] = [
  nginxWorkflow,
  diskCleanupWorkflow,
  serviceHealthWorkflow,
  dockerMaintenanceWorkflow,
  tlsCertificateWorkflow,
  systemUpdateWorkflow,
  connectionStatsWorkflow,
];

export function isBuiltInWorkflow(id: string) {
  return builtInWorkflows.some((workflow) => workflow.id === id);
}

export function workflowModeLabel(mode: WorkflowMode) {
  return mode === "flat" ? "并列手册" : "按步骤流程";
}

export function workflowModeHint(mode: WorkflowMode) {
  return mode === "flat"
    ? "条目彼此独立，执行时按需要挑一条，顺序不限。"
    : "步骤按编号推进，可以用前置步骤表达先后关系。";
}

export function newWorkflow(): Workflow {
  const now = Date.now();
  return {
    format: workflowFormat,
    schemaVersion: workflowSchemaVersion,
    id: crypto.randomUUID(),
    title: "新建工作流",
    description: "",
    mode: "sequence",
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

/**
 * Switching modes keeps the steps but rewrites the prerequisites: a manual
 * has none, a procedure falls back to a simple linear order.
 */
export function setWorkflowMode(
  workflow: Workflow,
  mode: WorkflowMode,
): Workflow {
  if (mode === workflow.mode) return workflow;
  if (mode === "flat")
    return {
      ...workflow,
      mode,
      steps: workflow.steps.map((step) => ({ ...step, dependsOn: [] })),
    };
  return {
    ...workflow,
    mode,
    steps: workflow.steps.map((step, index) => ({
      ...step,
      dependsOn:
        index === 0 ? [] : [workflow.steps[index - 1].id].filter(Boolean),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkflow(value: unknown): Workflow {
  if (!isRecord(value) || value.format !== workflowFormat)
    throw new Error("文件不是 Orbit SSH 工作流");
  if (
    value.schemaVersion !== workflowSchemaVersion &&
    value.schemaVersion !== legacyWorkflowSchemaVersion
  )
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

  const mode: WorkflowMode = value.mode === "flat" ? "flat" : "sequence";
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
      // A manual keeps every entry independent, so prerequisites are dropped.
      dependsOn: mode === "flat" ? [] : (item.dependsOn as string[]),
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
    mode,
    parameters,
    terminals,
    steps,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  };
}

function deletedBuiltIns(): string[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(deletedBuiltInsKey) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function markBuiltInDeleted(id: string) {
  if (!isBuiltInWorkflow(id)) return;
  const deleted = deletedBuiltIns();
  if (deleted.includes(id)) return;
  try {
    localStorage.setItem(deletedBuiltInsKey, JSON.stringify([...deleted, id]));
  } catch {
    /* Storage may be unavailable; the workflow is still removed for this session. */
  }
}

export function loadWorkflows(): Workflow[] {
  const deleted = deletedBuiltIns();
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null) {
      return builtInWorkflows.filter((item) => !deleted.includes(item.id));
    }
    const decoded: unknown = JSON.parse(stored);
    if (!Array.isArray(decoded)) return [];
    const saved = decoded.map(validateWorkflow);
    // Built-in samples stay available unless the user deleted them on purpose.
    const missing = builtInWorkflows.filter(
      (item) =>
        !deleted.includes(item.id) &&
        !saved.some((workflow) => workflow.id === item.id),
    );
    return [...saved, ...missing];
  } catch {
    return builtInWorkflows.filter((item) => !deleted.includes(item.id));
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
