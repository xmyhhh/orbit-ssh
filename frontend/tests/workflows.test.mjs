import assert from "node:assert/strict";
import test from "node:test";
import {
  builtInWorkflows,
  connectionStatsWorkflow,
  isBuiltInWorkflow,
  nginxWorkflow,
  renderWorkflowCommand,
  setWorkflowMode,
  validateWorkflow,
  workflowModeLabel,
} from "../src/workflows.ts";

function render(stepID, values = { port: "4080" }) {
  const step = connectionStatsWorkflow.steps.find(
    (item) => item.id === stepID,
  );
  assert.ok(step, `missing step ${stepID}`);
  return renderWorkflowCommand(
    step.command,
    values,
    connectionStatsWorkflow.parameters,
  );
}

test("the connection stats workflow ships as a built-in workflow", () => {
  assert.ok(
    builtInWorkflows.some(
      (workflow) => workflow.id === connectionStatsWorkflow.id,
    ),
  );
  assert.equal(isBuiltInWorkflow(connectionStatsWorkflow.id), true);
  assert.equal(connectionStatsWorkflow.parameters[0].defaultValue, "4080");
});

test("the built-in connection stats workflow is valid", () => {
  const workflow = validateWorkflow(connectionStatsWorkflow);
  assert.equal(workflow.title, "端口连接统计");
  assert.equal(workflow.steps.length, 5);
});

test("the connection stats workflow is a manual with independent entries", () => {
  assert.equal(connectionStatsWorkflow.mode, "flat");
  assert.equal(workflowModeLabel("flat"), "并列手册");
  for (const step of connectionStatsWorkflow.steps)
    assert.deepEqual(step.dependsOn, []);
});

test("every connection stats step targets the local port filter", () => {
  const rendered = connectionStatsWorkflow.steps.map((step) =>
    render(step.id),
  );
  assert.deepEqual(rendered, [
    "ss -tnp state established '( sport = :'4080' )'",
    "ss -Htan '( sport = :'4080' )' | awk 'NR>1{c[$1]++} END{for(k in c) print k, c[k]}'",
    "ss -Htn state established '( sport = :'4080' )' | awk '{print $4}' | cut -d: -f1 | sort | uniq -c | sort -rn | head -20",
    "ss -Htan '( sport = :'4080' )' | wc -l",
    "watch -n 1 'ss -Htn state established \"( sport = :'4080' )\" | wc -l'",
  ]);
  // A POSIX shell drops the quotes around the parameter, so the filter that
  // reaches ss is still the plain numeric port.
  for (const command of rendered) {
    assert.ok(command.includes("( sport = :'4080' )"));
    assert.equal(
      command.replaceAll("'", "").includes("( sport = :4080 )"),
      true,
    );
  }
});

test("the port parameter drives every step", () => {
  const rendered = connectionStatsWorkflow.steps.map((step) =>
    render(step.id, { port: "8443" }),
  );
  for (const command of rendered) {
    assert.equal(command.includes("4080"), false);
    assert.ok(command.includes("( sport = :'8443' )"));
  }
});

test("procedures keep their prerequisites and numbered steps", () => {
  assert.equal(nginxWorkflow.mode, "sequence");
  assert.equal(workflowModeLabel("sequence"), "按步骤流程");
  assert.deepEqual(nginxWorkflow.steps[2].dependsOn, ["nginx-inspect"]);
});

test("legacy workflow files migrate to the sequence mode", () => {
  const legacy = {
    format: "orbitssh.workflow",
    schemaVersion: 1,
    id: "legacy-v1",
    title: "旧工作流",
    description: "",
    parameters: [],
    terminals: [{ id: "main", label: "默认终端" }],
    steps: [
      {
        id: "one",
        title: "第一步",
        description: "",
        command: "echo one",
        terminalId: "main",
        optional: false,
        dependsOn: [],
      },
      {
        id: "two",
        title: "第二步",
        description: "",
        command: "echo two",
        terminalId: "main",
        optional: false,
        dependsOn: ["one"],
      },
    ],
    updatedAt: 1,
  };
  const migrated = validateWorkflow(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.mode, "sequence");
  assert.deepEqual(migrated.steps[1].dependsOn, ["one"]);
});

test("a manual never keeps prerequisites", () => {
  const flat = validateWorkflow({
    ...nginxWorkflow,
    id: "flat-copy",
    mode: "flat",
  });
  assert.equal(flat.mode, "flat");
  for (const step of flat.steps) assert.deepEqual(step.dependsOn, []);
});

test("switching modes rewrites the prerequisites", () => {
  const manual = setWorkflowMode(nginxWorkflow, "flat");
  assert.equal(manual.mode, "flat");
  for (const step of manual.steps) assert.deepEqual(step.dependsOn, []);

  const procedure = setWorkflowMode(connectionStatsWorkflow, "sequence");
  assert.equal(procedure.mode, "sequence");
  assert.deepEqual(procedure.steps[0].dependsOn, []);
  assert.deepEqual(procedure.steps[1].dependsOn, ["conn-detail"]);
  assert.deepEqual(procedure.steps[4].dependsOn, ["conn-all-states"]);
});
