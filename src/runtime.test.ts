import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { normalizeCanonicalOutcome, validateProfile, validateRuntimeConfig, verifyCompletedTaskOutcome, verifyTaskInputArtifacts } from "./validation";
import { githubEventToTask } from "./bridges/github";
import { discordEventToTask } from "./bridges/discord";
import { buildWorkflowTaskInput, getTemplateByName } from "./workflows";
import { compareSnapshots } from "./report";
import {
  cancelTaskByOperator,
  claimNextTask,
  enqueueTask,
  enqueueTaskIfNew,
  finalizeTask,
  getAllActiveWorkflows,
  getBundleByAttemptId,
  getRecentRunEvents,
  getTaskCountsByStatus,
  getTaskAttemptById,
  getTaskAttemptsForTask,
  getTaskById,
  getWorkflowByInstanceKey,
  insertWorkflow,
  openDb
} from "./db";
import { evaluateActiveWorkflows } from "./workflow-runtime";
import type { RuntimeConfig } from "./types";
import { writeArtifactIfNeeded } from "./artifacts";
import { assembleContext, compileBundle } from "./context";
import { buildAgentCliAuditDir, buildAgentCliInvocation, extractHermesResponseText } from "./adapters/cli";
import { loadConfig } from "./config";
import { resetRuntimeForTests, runOnce } from "./runtime";
import { readDispatchPause, writeDispatchPause } from "./pause";

test("normalizeCanonicalOutcome filters malformed arrays and invalid follow-up tasks", () => {
  const outcome = normalizeCanonicalOutcome(JSON.stringify({
    status: "success",
    operator_summary: "hello",
    file_changes: ["a.ts", 7],
    artifact_paths: ["artifacts/out.json", false],
    external_messages: [{ channel: "#ops" }, "bad"],
    follow_up_tasks: [
      { kind: "next", source: "operator", payload: { ok: true } },
      "bad"
    ]
  }));

  expect(outcome.status).toBe("completed");
  expect(outcome.file_changes).toEqual(["a.ts"]);
  expect(outcome.artifact_paths).toEqual(["artifacts/out.json"]);
  expect(outcome.external_messages).toEqual([{ channel: "#ops" }]);
  expect(outcome.follow_up_tasks).toEqual([{ kind: "next", source: "operator", payload: { ok: true } }]);
});

test("normalizeCanonicalOutcome falls back to raw text", () => {
  const outcome = normalizeCanonicalOutcome("not-json");
  expect(outcome.status).toBe("completed");
  expect(outcome.operator_summary).toBe("not-json");
});

test("normalizeCanonicalOutcome accepts fenced json", () => {
  const outcome = normalizeCanonicalOutcome([
    "```json",
    "{",
    '  "status": "completed",',
    '  "operator_summary": "codex output"',
    "}",
    "```"
  ].join("\n"));

  expect(outcome.status).toBe("completed");
  expect(outcome.operator_summary).toBe("codex output");
});

test("normalizeCanonicalOutcome accepts prose plus fenced json", () => {
  const outcome = normalizeCanonicalOutcome([
    "Completed the task. Returning structured output.",
    "",
    "```json",
    "{",
    '  "status": "completed",',
    '  "operator_summary": "artifact verified",',
    '  "artifact_paths": ["campaigns/cairn/clone-readiness-charter.md"]',
    "}",
    "```"
  ].join("\n"));

  expect(outcome.status).toBe("completed");
  expect(outcome.operator_summary).toBe("artifact verified");
  expect(outcome.artifact_paths).toEqual(["campaigns/cairn/clone-readiness-charter.md"]);
});

test("normalizeCanonicalOutcome marks sandbox-blocked text as blocked", () => {
  const outcome = normalizeCanonicalOutcome([
    "Based on my verification attempt, here's the status:",
    "",
    "**Status: BLOCKED**",
    "",
    "The sandbox environment is blocking all shell commands.",
    "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
  ].join("\n"));

  expect(outcome.status).toBe("blocked");
  expect(outcome.machine_status).toBe("blocked");
});

test("verifyCompletedTaskOutcome rejects prompt echo", async () => {
  const config = testConfig();
  const task = {
    task_id: "task-1",
    kind: "runtime-improvement",
    source: "operator:test",
    subject: "spec",
    description: null,
    priority: 5,
    payload: {
      proposal_artifact: "plans/lumen/spec.md"
    },
    requested_profile: "lumen",
    requested_adapter: "ollama-qwen",
    status: "completed" as const,
    created_at: "2026-04-10T00:00:00Z",
    updated_at: "2026-04-10T00:00:00Z",
    attempt_count: 1,
    max_attempts: 3,
    available_at: "2026-04-10T00:00:00Z",
    started_at: "2026-04-10T00:00:00Z",
    finished_at: "2026-04-10T00:00:01Z",
    outcome: null,
    last_error: null
  };

  const issues = await verifyCompletedTaskOutcome(config, task, {
    status: "completed",
    operator_summary: "{\"task\":\"explain_changes\"}",
    machine_status: "ok",
    artifact_paths: [],
    raw_output: "{\"task\":\"explain_changes\"}"
  });

  expect(issues).toContain("model returned prompt/context echo instead of a task result");
});

test("verifyCompletedTaskOutcome accepts written declared artifacts", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  const task = {
    task_id: "task-2",
    kind: "runtime-improvement",
    source: "operator:test",
    subject: "spec",
    description: null,
    priority: 5,
    payload: {
      proposal_artifact: "state/artifacts/plans/lumen/spec.md"
    },
    requested_profile: "lumen",
    requested_adapter: "ollama-qwen",
    status: "completed" as const,
    created_at: "2026-04-10T00:00:00Z",
    updated_at: "2026-04-10T00:00:00Z",
    attempt_count: 1,
    max_attempts: 3,
    available_at: "2026-04-10T00:00:00Z",
    started_at: "2026-04-10T00:00:00Z",
    finished_at: "2026-04-10T00:00:01Z",
    outcome: null,
    last_error: null
  };

  const outcome = {
    status: "completed" as const,
    operator_summary: "created the spec",
    machine_status: "ok" as const,
    artifact_paths: [] as string[],
    raw_output: "{\"status\":\"success\"}"
  };

  const writtenPaths = await writeArtifactIfNeeded(config, task, outcome);
  outcome.artifact_paths = writtenPaths;
  const issues = await verifyCompletedTaskOutcome(config, task, outcome);

  expect(issues).toEqual([]);
});

test("verifyCompletedTaskOutcome rejects nonexistent claimed file changes", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  const task = {
    task_id: "task-claimed-paths",
    kind: "goal-verify-execute",
    source: "workflow:10:verify-execute",
    subject: "verify execute",
    description: null,
    priority: 5,
    payload: {
      verification_artifact: "state/artifacts/reports/live-ops-verify.md"
    },
    requested_profile: "proving-codex",
    requested_adapter: "codex-ollama",
    status: "completed" as const,
    created_at: "2026-04-10T00:00:00Z",
    updated_at: "2026-04-10T00:00:00Z",
    attempt_count: 1,
    max_attempts: 3,
    available_at: "2026-04-10T00:00:00Z",
    started_at: "2026-04-10T00:00:00Z",
    finished_at: "2026-04-10T00:00:01Z",
    outcome: null,
    last_error: null
  };

  await writeTestArtifact(config, "reports/live-ops-verify.md", "# Verify\n");
  const issues = await verifyCompletedTaskOutcome(config, task, {
    status: "completed",
    operator_summary: "claimed core modules shipped",
    machine_status: "ok",
    file_changes: ["src/lumen/messaging.rs - messaging core module"],
    artifact_paths: [path.join(config.artifactDir, "reports/live-ops-verify.md")],
    raw_output: "{\"status\":\"completed\"}"
  });

  expect(issues).toContain("claimed file change missing from filesystem: src/lumen/messaging.rs");
});

test("verifyCompletedTaskOutcome rejects completed outcomes that still describe sandbox escalation blockers", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  const task = testTaskRecord({
    kind: "goal-verify-execute",
    payload: {
      verification_artifact: "reports/runtime-audit-verify-execute-1.md"
    }
  });

  await writeTestArtifact(config, "reports/runtime-audit-verify-execute-1.md", "# Verify\n");
  const issues = await verifyCompletedTaskOutcome(config, task, {
    status: "completed",
    operator_summary: "Iteration 1 verified but permission escalation required before continuing.",
    machine_status: "ok",
    artifact_paths: [path.join(config.artifactDir, "reports/runtime-audit-verify-execute-1.md")],
    raw_output: "{\"status\":\"continue\",\"operator_summary\":\"Sandbox blockage confirmed as environmental constraint. Permission escalation required.\"}"
  });

  expect(issues).toContain("completed outcome text indicates execution was blocked");
});

test("verifyCompletedTaskOutcome accepts managed artifact paths reported with deploy prefix", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-deploy-prefix.db`);
  await writeTestArtifact(config, "plans/lumen-simplified-bounded-2026-04-12-03-plan.md", "# Plan\n\nManaged plan.\n");

  const issues = await verifyCompletedTaskOutcome(config, testTaskRecord({
    kind: "goal-plan",
    payload: {
      proposal_artifact: "plans/lumen-simplified-bounded-2026-04-12-03-plan.md"
    }
  }), {
    status: "completed",
    operator_summary: "plan written",
    machine_status: "ok",
    artifact_paths: ["deploy/lumen/state/artifacts/plans/lumen-simplified-bounded-2026-04-12-03-plan.md"],
    raw_output: "{\"status\":\"completed\"}"
  });

  expect(issues).toEqual([]);
});

test("verifyCompletedTaskOutcome ignores sentinel file change labels without paths", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-sentinel-change.db`);
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n\nManaged plan.\n");

  const issues = await verifyCompletedTaskOutcome(config, testTaskRecord({
    kind: "goal-plan",
    payload: {
      proposal_artifact: "plans/runtime-hardening-plan.md"
    }
  }), {
    status: "completed",
    operator_summary: "plan written",
    machine_status: "ok",
    file_changes: ["created"],
    artifact_paths: ["plans/runtime-hardening-plan.md"],
    raw_output: "{\"status\":\"completed\"}"
  });

  expect(issues).toEqual([]);
});

test("verifyTaskInputArtifacts rejects polluted goal-loop plan artifacts", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/lumen/polluted-plan.md", [
    "# Execute iteration 1: Polluted workflow",
    "",
    "- Kind: goal-execute",
    "",
    "```json",
    "{\"phase\":\"execute\"}",
    "```"
  ].join("\n"));
  await writeTestArtifact(config, "reports/lumen-execute-1.md", "# Execute\n\nRan repo inspection.\n");

  const issues = await verifyTaskInputArtifacts(config, testTaskRecord({
    kind: "goal-verify",
    payload: {
      phase: "verify",
      proposal_artifact: "plans/lumen/polluted-plan.md",
      implementation_artifact: "reports/lumen-execute-1.md",
      verification_artifact: "reports/lumen-verify-1.md"
    }
  }));

  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain("proposal artifact polluted");
});

test("verifyTaskInputArtifacts accepts clean goal-loop plan artifacts with follow-up execute metadata", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-plan-followup.db`);
  await writeTestArtifact(config, "plans/lumen/clean-plan-with-followup.md", [
    "# Plan goal: Validate the thinner Lumen proving loop on the live host",
    "",
    "- Kind: goal-plan",
    "",
    "```json",
    "{\"status\":\"completed\",\"follow_up_tasks\":[{\"kind\":\"goal-execute\",\"payload\":{\"plan_artifact\":\"plans/lumen/clean-plan-with-followup.md\"}}],\"workflow_signal\":\"plan_ready\"}",
    "```"
  ].join("\n"));

  const issues = await verifyTaskInputArtifacts(config, testTaskRecord({
    kind: "goal-execute",
    payload: {
      phase: "execute",
      proposal_artifact: "plans/lumen/clean-plan-with-followup.md",
      implementation_artifact: "reports/lumen-execute-1.md"
    }
  }));

  expect(issues).toEqual([]);
});

test("verifyTaskInputArtifacts rejects polluted goal-loop execute artifacts", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/lumen/clean-plan.md", "# Plan\n\nBounded repo inspection.\n");
  await writeTestArtifact(config, "reports/lumen-execute-1.md", [
    "# Verify execution iteration 1: Polluted execute artifact",
    "",
    "- Kind: goal-verify-execute",
    "",
    "```json",
    "{\"phase\":\"verify-execute\"}",
    "```"
  ].join("\n"));

  const issues = await verifyTaskInputArtifacts(config, testTaskRecord({
    kind: "goal-verify",
    payload: {
      phase: "verify",
      proposal_artifact: "plans/lumen/clean-plan.md",
      implementation_artifact: "reports/lumen-execute-1.md",
      verification_artifact: "reports/lumen-verify-1.md"
    }
  }));

  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain("implementation artifact polluted");
});

test("verifyTaskInputArtifacts accepts clean goal-loop artifacts", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/lumen/clean-plan.md", "# Plan\n\nBounded repo inspection with acceptance criteria and stop condition.\n");
  await writeTestArtifact(config, "reports/lumen-execute-1.md", "# Execute iteration 1\n\nRan repo inspection and wrote evidence.\n");

  const issues = await verifyTaskInputArtifacts(config, testTaskRecord({
    kind: "goal-verify",
    payload: {
      phase: "verify",
      proposal_artifact: "plans/lumen/clean-plan.md",
      implementation_artifact: "reports/lumen-execute-1.md",
      verification_artifact: "reports/lumen-verify-1.md"
    }
  }));

  expect(issues).toEqual([]);
});

test("verifyTaskInputArtifacts does not require an execute artifact before execute runs", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-execute-input.db`);
  await writeTestArtifact(config, "plans/lumen/clean-plan.md", "# Plan\n\nBounded repo inspection with acceptance criteria and stop condition.\n");

  const issues = await verifyTaskInputArtifacts(config, testTaskRecord({
    kind: "goal-execute",
    payload: {
      phase: "execute",
      proposal_artifact: "plans/lumen/clean-plan.md",
      implementation_artifact: "reports/lumen-execute-1.md"
    }
  }));

  expect(issues).toEqual([]);
});

test("verifyCompletedTaskOutcome rejects out-of-root duplicate artifact files", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n\nManaged plan.\n");
  await mkdir(path.join(process.cwd(), "plans"), { recursive: true });
  await Bun.write(path.join(process.cwd(), "plans/runtime-hardening-plan.md"), "# Plan\n\nDuplicate plan.\n");

  const issues = await verifyCompletedTaskOutcome(config, testTaskRecord({
    kind: "goal-plan",
    payload: {
      proposal_artifact: "plans/runtime-hardening-plan.md",
      required_artifacts: ["plans/runtime-hardening-plan.md"]
    }
  }), {
    status: "completed",
    operator_summary: "plan written",
    machine_status: "ok",
    artifact_paths: [path.join(config.artifactDir, "plans/runtime-hardening-plan.md")],
    raw_output: "{\"status\":\"completed\"}"
  });

  expect(issues).toContain("declared artifact also exists outside managed artifact root: plans/runtime-hardening-plan.md");
  await rm(path.join(process.cwd(), "plans/runtime-hardening-plan.md"), { force: true });
});

test("writeArtifactIfNeeded writes only the verification artifact for goal verification tasks", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-verify-only.db`);
  const task = {
    task_id: "task-verify-artifact",
    kind: "goal-verify",
    source: "workflow:11:verify",
    subject: "verify execution",
    description: null,
    priority: 5,
    payload: {
      proposal_artifact: "plans/runtime-hardening-plan.md",
      implementation_artifact: "reports/runtime-hardening-execute-1.md",
      verification_artifact: "reports/runtime-hardening-verify-1.md",
      required_artifacts: ["reports/runtime-hardening-verify-1.md"]
    },
    requested_profile: "proving-codex",
    requested_adapter: "codex-ollama",
    status: "completed" as const,
    created_at: "2026-04-10T00:00:00Z",
    updated_at: "2026-04-10T00:00:00Z",
    attempt_count: 1,
    max_attempts: 3,
    available_at: "2026-04-10T00:00:00Z",
    started_at: "2026-04-10T00:00:00Z",
    finished_at: "2026-04-10T00:00:01Z",
    outcome: null,
    last_error: null
  };

  const writtenPaths = await writeArtifactIfNeeded(config, task, {
    status: "completed",
    operator_summary: "verification artifact",
    machine_status: "ok",
    artifact_paths: [],
    raw_output: "{\"status\":\"completed\"}"
  });

  expect(writtenPaths).toEqual([path.join(config.artifactDir, "reports/runtime-hardening-verify-1.md")]);
  expect(await Bun.file(path.join(config.artifactDir, "plans/runtime-hardening-plan.md")).exists()).toBeFalse();
  expect(await Bun.file(path.join(config.artifactDir, "reports/runtime-hardening-execute-1.md")).exists()).toBeFalse();
});

test("github bridge produces a lumen task", () => {
  const task = githubEventToTask({
    event: "pull_request.closed",
    repository: "aibtcdev/agent-runtime",
    title: "Extract shared runtime",
    number: 9,
    author: "arc0btc",
    url: "https://github.com/aibtcdev/agent-runtime/pull/9",
    merged: true
  });

  expect(task.requested_profile).toBe("lumen");
  expect(task.kind).toBe("github-story");
  expect(task.source).toBe("github-bridge");
});

test("discord bridge produces a lumen task", () => {
  const task = discordEventToTask({
    event: "discord.mention",
    channel: "community-updates",
    author: "whoabuddy",
    message: "Explain this change"
  });

  expect(task.requested_profile).toBe("lumen");
  expect(task.kind).toBe("discord-reply");
  expect(task.source).toBe("discord-bridge");
});

test("validateProfile flags missing critical fields", () => {
  const issues = validateProfile({
    profile_id: "",
    style: "claude-like",
    role: "",
    system_prompt_parts: [],
    skills: [],
    default_adapter: "",
    tool_policy: {},
    context_policy: {
      include_recent_task_memory: true,
      max_prompt_chars: 16000
    },
    result_schema: {},
    integration_policies: {}
  });

  expect(issues.length).toBeGreaterThan(0);
});

test("community research workflow template exists", () => {
  const template = getTemplateByName("community-research");
  expect(template?.initialState).toBe("discover-aibtc-basics");
});

test("goal loop workflow template exists", () => {
  const template = getTemplateByName("goal-loop");
  expect(template?.initialState).toBe("plan");
});

test("workflow task input gets a deduped workflow source", () => {
  const input = buildWorkflowTaskInput(
    {
      id: 7,
      template: "community-research",
      instance_key: "lumen-community-wiki",
      current_state: "discover-aibtc-basics",
      context_json: null,
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-10T00:00:00Z",
      completed_at: null
    },
    {
      kind: "community-research",
      source: "workflow:pending",
      payload: { topic: "AIBTC" }
    }
  );

  expect(input.source).toBe("workflow:7:discover-aibtc-basics");
  expect(input.payload.workflow_id).toBe(7);
});

test("enqueueTask leaves requested_adapter empty when omitted so profile defaults can apply", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const task = enqueueTask(db, config, {
      kind: "codex-smoke",
      source: "operator:test",
      requested_profile: "proving-codex",
      payload: {}
    });

    expect(task.requested_profile).toBe("proving-codex");
    expect(task.requested_adapter).toBe("");
  } finally {
    db.close(false);
  }
});

test("enqueueTaskIfNew allows a new task after the prior source finished", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const first = enqueueTask(db, config, {
      kind: "goal-execute",
      source: "workflow:9:execute",
      requested_profile: "proving-codex",
      payload: {}
    });
    finalizeTask(db, first.task_id, {
      status: "completed",
      operator_summary: "finished",
      machine_status: "ok"
    });

    const second = enqueueTaskIfNew(db, config, {
      kind: "goal-execute",
      source: "workflow:9:execute",
      requested_profile: "proving-codex",
      payload: {}
    });

    expect(second).not.toBeNull();
    expect(second?.task_id).not.toBe(first.task_id);
  } finally {
    db.close(false);
  }
});

test("goal loop plan context includes objective and scope", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "goal-plan",
    payload: {
      workflow_template: "goal-loop",
      phase: "plan",
      objective: "Harden the runtime",
      scope: ["src/context.ts", "src/runtime.test.ts"],
      phase_skills: ["planning"]
    }
  }));

  expect(context).toContain("Workflow context:");
  expect(context).toContain("- Phase: plan");
  expect(context).toContain("- Objective: Harden the runtime");
  expect(context).toContain("- Scope: src/context.ts, src/runtime.test.ts");
});

test("goal loop execute context points to the approved plan on disk without inlining artifact content", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n\nShip the hardening work.");

  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "goal-execute",
    payload: {
      workflow_template: "goal-loop",
      phase: "execute",
      objective: "Harden the runtime",
      proposal_artifact: "plans/runtime-hardening-plan.md",
      implementation_artifact: "reports/runtime-hardening-execute-1.md",
      iteration: 1
    }
  }));

  expect(context).toContain("Approved plan artifact: plans/runtime-hardening-plan.md");
  expect(context).toContain(`- On disk: ${path.join(config.artifactDir, "plans/runtime-hardening-plan.md")}`);
  expect(context).not.toContain("Ship the hardening work.");
});

test("goal loop execute context references the latest verification path when present", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n\nApproved implementation plan.");
  await writeTestArtifact(config, "reports/runtime-hardening-verify-1.md", "# Verify\n\nContinue or complete.");

  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "goal-execute",
    payload: {
      workflow_template: "goal-loop",
      phase: "execute",
      objective: "Harden the runtime",
      proposal_artifact: "plans/runtime-hardening-plan.md",
      implementation_artifact: "reports/runtime-hardening-execute-2.md",
      iteration: 2
    }
  }));

  expect(context).toContain("Approved plan artifact: plans/runtime-hardening-plan.md");
  expect(context).toContain("Latest verification artifact: reports/runtime-hardening-verify-1.md");
  expect(context).toContain(`- On disk: ${path.join(config.artifactDir, "reports/runtime-hardening-verify-1.md")}`);
});

test("goal loop verify context references on-disk artifacts and warns against trusting summaries", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n\nExecution target.");
  await writeTestArtifact(config, "reports/runtime-hardening-execute-2.md", "# Execute\n\nApplied the runtime patch.");
  await writeTestArtifact(config, "reports/runtime-hardening-verify-1.md", "# Verify\n\nContinue with the next step.");

  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "goal-verify",
    payload: {
      workflow_template: "goal-loop",
      phase: "verify",
      objective: "Harden the runtime",
      proposal_artifact: "plans/runtime-hardening-plan.md",
      implementation_artifact: "reports/runtime-hardening-execute-2.md",
      verification_artifact: "reports/runtime-hardening-verify-2.md",
      iteration: 2
    }
  }));

  expect(context).toContain("Approved plan artifact: plans/runtime-hardening-plan.md");
  expect(context).toContain("Latest execute artifact: reports/runtime-hardening-execute-2.md");
  expect(context).toContain("Latest verification artifact: reports/runtime-hardening-verify-1.md");
  expect(context).toContain("Use current-run shell commands, adapter audit bundles, and direct file reads as the source of truth.");
  expect(context).toContain(`- On disk: ${path.join(config.artifactDir, "reports/runtime-hardening-execute-2.md")}`);
});

test("goal loop context no longer inlines oversized artifact content", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}.db`);
  const profile = testProfile({ context_policy: { include_recent_task_memory: true, max_prompt_chars: 2600 } });
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", `${"line\n".repeat(300)}tail`);

  const context = assembleContext(config, profile, testTaskRecord({
    kind: "goal-verify",
    payload: {
      workflow_template: "goal-loop",
      phase: "verify",
      objective: "Harden the runtime",
      proposal_artifact: "plans/runtime-hardening-plan.md",
      implementation_artifact: "reports/runtime-hardening-execute-1.md",
      verification_artifact: "reports/runtime-hardening-verify-1.md",
      iteration: 1
    }
  }));

  expect(context.length).toBeLessThanOrEqual(2600);
  expect(context).toContain("Approved plan artifact: plans/runtime-hardening-plan.md");
  expect(context).not.toContain("tail");
});

test("artifact-writing context requires declared managed artifact paths in artifact_paths", () => {
  const config = testConfig();
  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "campaign-bootstrap",
    payload: {
      required_artifacts: ["campaigns/cairn/clone-readiness-charter.md"]
    }
  }));

  expect(context).toContain("This task declares managed artifacts.");
  expect(context).toContain("Expected managed artifact paths for this task: campaigns/cairn/clone-readiness-charter.md.");
  expect(context).toContain("include their relative managed paths in `artifact_paths`");
});

test("github story context requires empty artifact paths for summary-only runs", () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-github-story.db`);
  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "github-story",
    source: "github-bridge",
    payload: {
      repository: "aibtcdev/agent-runtime",
      title: "Extract shared runtime skeleton",
      number: 7,
      author: "arc0btc",
      url: "https://github.com/aibtcdev/agent-runtime/pull/7",
      merged: true,
      summary: "Introduces a shared runtime skeleton with profile-based dispatch and Ollama proving adapter."
    }
  }));

  expect(context).toContain("Task-specific output rules:");
  expect(context).toContain("Report `artifact_paths` as an empty array unless you actually wrote a managed artifact under the runtime artifact directory.");
  expect(context).toContain("Do not put repository source paths in `artifact_paths`; mention them in `file_changes` or `operator_summary` instead.");
  expect(context).toContain("Report `file_changes` as an empty array unless this run actually edited files.");
});

test("discord reply context requires empty file and artifact reports for reply-only runs", () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-discord-reply.db`);
  const context = assembleContext(config, testProfile(), testTaskRecord({
    kind: "discord-reply",
    source: "discord-bridge",
    payload: {
      channel: "community-updates",
      author: "whoabuddy",
      message: "Can Lumen explain what changed in the new agent-runtime work without giving raw diff noise?",
      reply_style: "short",
      operator_goal: "Reply as Lumen with a concise, story-first explanation."
    }
  }));

  expect(context).toContain("Task-specific output rules:");
  expect(context).toContain("This is reply-only work. Do not invent repository edits, changelog files, or managed artifacts for this task.");
  expect(context).toContain("Draft the reply in `operator_summary` unless the task explicitly asks for another channel-specific format.");
  expect(context).toContain("Report `artifact_paths` as an empty array unless you actually wrote a managed artifact under the runtime artifact directory.");
  expect(context).toContain("Report `file_changes` as an empty array unless this run actually edited files.");
});

test("buildAgentCliInvocation constructs codex exec command for ollama responses provider", () => {
  const runtimeConfig = testConfig();
  const invocation = buildAgentCliInvocation(
    {
      task: testTaskRecord({
        task_id: "codex-task",
        requested_adapter: "codex-ollama"
      }),
      attempt: {
        attempt_id: "attempt-codex-task",
        task_id: "codex-task",
        adapter_id: "codex-ollama",
        adapter_kind: "agent-cli",
        model: "qwen3.5:35b",
        runner_id: "runner-test",
        bundle_id: "bundle-codex-task",
        status: "running",
        started_at: "2026-04-10T00:00:00Z",
        ended_at: null,
        exit_status: null,
        retry_class: null,
        prompt_path: null,
        stdout_path: null,
        stderr_path: null,
        result_path: null,
        diagnostics: null
      },
      bundle: {
        bundle_id: "bundle-codex-task",
        task_id: "codex-task",
        attempt_id: "attempt-codex-task",
        bundle_hash: "bundle-hash-codex-task",
        agent_id: "test-runtime",
        profile_id: "lumen",
        adapter_id: "codex-ollama",
        model: "qwen3.5:35b",
        variant_id: null,
        evaluator_version: null,
        replay_grade: "non_replayable_model",
        relative_path: "bundles/2026-04-10/bundle-codex-task.json",
        prompt_relative_path: "bundles/2026-04-10/bundle-codex-task.prompt.txt",
        created_at: "2026-04-10T00:00:00Z"
      },
      profile: testProfile(),
      adapterId: "codex-ollama",
      adapterConfig: {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        model: "qwen3.5:35b",
        timeoutMs: 900000,
        workingDir: "/tmp/workspace",
        sandbox: "workspace-write",
        providerId: "ollama_remote",
        providerName: "Ollama Remote",
        providerBaseUrl: "http://192.168.1.69:11434/v1",
        providerWireApi: "responses",
        providerRequiresOpenAIAuth: false,
        autonomy: "trusted-vm",
        env: {
          CODEX_HOME: "./state/codex-home"
        }
      },
      runtimeConfig,
      assembledContext: "Return JSON."
    },
    {
      mode: "agent-cli",
      driver: "codex",
      command: "codex",
      model: "qwen3.5:35b",
      timeoutMs: 900000,
      workingDir: "/tmp/workspace",
      sandbox: "workspace-write",
      providerId: "ollama_remote",
      providerName: "Ollama Remote",
      providerBaseUrl: "http://192.168.1.69:11434/v1",
      providerWireApi: "responses",
      providerRequiresOpenAIAuth: false,
      autonomy: "trusted-vm",
      env: {
        CODEX_HOME: "./state/codex-home"
      }
    },
    "/tmp/last-message.txt"
  );

  expect(invocation.command).toBe("codex");
  expect(invocation.cwd).toBe("/tmp/workspace");
  expect(invocation.env.CODEX_HOME).toBe("./state/codex-home");
  expect(invocation.args).toContain("exec");
  expect(invocation.args).toContain("--json");
  expect(invocation.args).toContain("--output-last-message");
  expect(invocation.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(invocation.args).toContain("/tmp/last-message.txt");
  expect(invocation.args).toContain(`model="qwen3.5:35b"`);
  expect(invocation.args).toContain(`model_provider="ollama_remote"`);
  expect(invocation.args).toContain(`model_providers.ollama_remote={name="Ollama Remote",base_url="http://192.168.1.69:11434/v1",wire_api="responses",requires_openai_auth=false}`);
  expect(invocation.args.at(-1)).toBe("-");
});

test("buildAgentCliInvocation leaves provider unset for codex subscription config", () => {
  const runtimeConfig = testConfig();
  const invocation = buildAgentCliInvocation(
    {
      task: testTaskRecord({
        task_id: "codex-subscription-task",
        requested_adapter: "codex-subscription"
      }),
      attempt: {
        attempt_id: "attempt-codex-subscription-task",
        task_id: "codex-subscription-task",
        adapter_id: "codex-subscription",
        adapter_kind: "agent-cli",
        model: null,
        runner_id: "runner-test",
        bundle_id: "bundle-codex-subscription-task",
        status: "running",
        started_at: "2026-04-10T00:00:00Z",
        ended_at: null,
        exit_status: null,
        retry_class: null,
        prompt_path: null,
        stdout_path: null,
        stderr_path: null,
        result_path: null,
        diagnostics: null
      },
      bundle: {
        bundle_id: "bundle-codex-subscription-task",
        task_id: "codex-subscription-task",
        attempt_id: "attempt-codex-subscription-task",
        bundle_hash: "bundle-hash-codex-subscription-task",
        agent_id: "test-runtime",
        profile_id: "cairn",
        adapter_id: "codex-subscription",
        model: null,
        variant_id: null,
        evaluator_version: null,
        replay_grade: "non_replayable_model",
        relative_path: "bundles/2026-04-10/bundle-codex-subscription-task.json",
        prompt_relative_path: "bundles/2026-04-10/bundle-codex-subscription-task.prompt.txt",
        created_at: "2026-04-10T00:00:00Z"
      },
      profile: testProfile({ profile_id: "cairn", default_adapter: "codex-subscription" }),
      adapterId: "codex-subscription",
      adapterConfig: {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        timeoutMs: 900000,
        workingDir: "/tmp/workspace",
        sandbox: "workspace-write",
        autonomy: "trusted-vm",
        env: {
          CODEX_HOME: "./state/codex-home"
        }
      },
      runtimeConfig,
      assembledContext: "Return JSON."
    },
    {
      mode: "agent-cli",
      driver: "codex",
      command: "codex",
      timeoutMs: 900000,
      workingDir: "/tmp/workspace",
      sandbox: "workspace-write",
      autonomy: "trusted-vm",
      env: {
        CODEX_HOME: "./state/codex-home"
      }
    },
    "/tmp/last-message.txt"
  );

  expect(invocation.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(invocation.args.some((arg) => arg.includes("model_provider"))).toBe(false);
  expect(invocation.args.some((arg) => arg.includes("model_providers."))).toBe(false);
  expect(invocation.args.some((arg) => arg.startsWith("model="))).toBe(false);
  expect(invocation.args.at(-1)).toBe("-");
});

test("buildAgentCliInvocation constructs claude command with trusted-vm permissions", () => {
  const runtimeConfig = testConfig();
  const invocation = buildAgentCliInvocation(
    {
      task: testTaskRecord({
        task_id: "claude-task",
        requested_adapter: "claude-local"
      }),
      attempt: {
        attempt_id: "attempt-claude-task",
        task_id: "claude-task",
        adapter_id: "claude-local",
        adapter_kind: "agent-cli",
        model: "qwen3.6:35b",
        runner_id: "runner-test",
        bundle_id: "bundle-claude-task",
        status: "running",
        started_at: "2026-04-10T00:00:00Z",
        ended_at: null,
        exit_status: null,
        retry_class: null,
        prompt_path: null,
        stdout_path: null,
        stderr_path: null,
        result_path: null,
        diagnostics: null
      },
      bundle: {
        bundle_id: "bundle-claude-task",
        task_id: "claude-task",
        attempt_id: "attempt-claude-task",
        bundle_hash: "bundle-hash-claude-task",
        agent_id: "test-runtime",
        profile_id: "lumen",
        adapter_id: "claude-local",
        model: "qwen3.6:35b",
        variant_id: null,
        evaluator_version: null,
        replay_grade: "non_replayable_model",
        relative_path: "bundles/2026-04-10/bundle-claude-task.json",
        prompt_relative_path: "bundles/2026-04-10/bundle-claude-task.prompt.txt",
        created_at: "2026-04-10T00:00:00Z"
      },
      profile: testProfile(),
      adapterId: "claude-local",
      adapterConfig: {
        mode: "agent-cli",
        driver: "claude-code",
        command: "claude",
        model: "qwen3.6:35b",
        timeoutMs: 900000,
        workingDir: "/tmp/workspace",
        settingsFile: "/tmp/claude-settings.json",
        autonomy: "trusted-vm"
      },
      runtimeConfig,
      assembledContext: "Return JSON."
    },
    {
      mode: "agent-cli",
      driver: "claude-code",
      command: "claude",
      model: "qwen3.6:35b",
      timeoutMs: 900000,
      workingDir: "/tmp/workspace",
      settingsFile: "/tmp/claude-settings.json",
      autonomy: "trusted-vm"
    },
    "/tmp/last-message.txt"
  );

  expect(invocation.command).toBe("claude");
  expect(invocation.cwd).toBe("/tmp/workspace");
  expect(invocation.inputText).toBeUndefined();
  expect(invocation.args).toEqual([
    "-p",
    "--output-format",
    "json",
    "--model",
    "qwen3.6:35b",
    "--settings",
    "/tmp/claude-settings.json",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "Return JSON."
  ]);
});

test("buildAgentCliInvocation constructs hermes command with trusted-vm yolo posture", () => {
  const runtimeConfig = testConfig();
  const invocation = buildAgentCliInvocation(
    {
      task: testTaskRecord({
        task_id: "hermes-task",
        requested_adapter: "hermes-local"
      }),
      attempt: {
        attempt_id: "attempt-hermes-task",
        task_id: "hermes-task",
        adapter_id: "hermes-local",
        adapter_kind: "agent-cli",
        model: "qwen3.6:35b",
        runner_id: "runner-test",
        bundle_id: "bundle-hermes-task",
        status: "running",
        started_at: "2026-04-10T00:00:00Z",
        ended_at: null,
        exit_status: null,
        retry_class: null,
        prompt_path: null,
        stdout_path: null,
        stderr_path: null,
        result_path: null,
        diagnostics: null
      },
      bundle: {
        bundle_id: "bundle-hermes-task",
        task_id: "hermes-task",
        attempt_id: "attempt-hermes-task",
        bundle_hash: "bundle-hash-hermes-task",
        agent_id: "test-runtime",
        profile_id: "lumen",
        adapter_id: "hermes-local",
        model: "qwen3.6:35b",
        variant_id: null,
        evaluator_version: null,
        replay_grade: "non_replayable_model",
        relative_path: "bundles/2026-04-10/bundle-hermes-task.json",
        prompt_relative_path: "bundles/2026-04-10/bundle-hermes-task.prompt.txt",
        created_at: "2026-04-10T00:00:00Z"
      },
      profile: testProfile(),
      adapterId: "hermes-local",
      adapterConfig: {
        mode: "agent-cli",
        driver: "hermes-agent",
        command: "hermes",
        model: "qwen3.6:35b",
        timeoutMs: 900000,
        workingDir: "/tmp/workspace",
        autonomy: "trusted-vm"
      },
      runtimeConfig,
      assembledContext: "Return JSON."
    },
    {
      mode: "agent-cli",
      driver: "hermes-agent",
      command: "hermes",
      model: "qwen3.6:35b",
      timeoutMs: 900000,
      workingDir: "/tmp/workspace",
      autonomy: "trusted-vm"
    },
    "/tmp/last-message.txt"
  );

  expect(invocation.command).toBe("hermes");
  expect(invocation.cwd).toBe("/tmp/workspace");
  expect(invocation.inputText).toBeUndefined();
  expect(invocation.args).toEqual(["chat", "-Q", "--model", "qwen3.6:35b", "--yolo", "-q", "Return JSON."]);
});

test("extractHermesResponseText strips quiet-mode session metadata", () => {
  const raw = [
    "session_id: 20260423_152844_5668d1",
    '{"status":"completed","machine_status":"ok"}'
  ].join("\n");

  expect(extractHermesResponseText(raw)).toBe('{"status":"completed","machine_status":"ok"}');
});

test("buildAgentCliAuditDir scopes adapter evidence per attempt", () => {
  const first = buildAgentCliAuditDir("/tmp/runtime-artifacts", "task-123", "attempt-1");
  const second = buildAgentCliAuditDir("/tmp/runtime-artifacts", "task-123", "attempt-2");

  expect(first).toBe(path.join("/tmp/runtime-artifacts", "adapter-runs", "task-123", "attempt-1"));
  expect(second).toBe(path.join("/tmp/runtime-artifacts", "adapter-runs", "task-123", "attempt-2"));
  expect(first).not.toBe(second);
});

test("loadConfig resolves agent-cli env files and working directories", async () => {
  const rootDir = `/tmp/load-config-${Date.now()}`;
  await mkdir(`${rootDir}/config`, { recursive: true });
  await Bun.write(`${rootDir}/config/runtime.json`, JSON.stringify({
    runtimeName: "test",
    runtimePolicy: "test",
    stateDir: "./state",
    logDir: "./state/logs",
    artifactDir: "./state/artifacts",
    dbPath: "./state/runtime.db",
    lockPath: "./state/dispatch.lock",
    defaultProfile: "lumen",
    defaultAdapter: "codex-ollama",
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    profiles: {
      lumen: "../profiles/lumen/profile.json"
    },
    adapters: {
      "codex-ollama": {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        timeoutMs: 900000,
        workingDir: "..",
        envFile: "./codex.env",
        settingsFile: "./claude-settings.json"
      }
    }
  }, null, 2));
  await mkdir(`${rootDir}/profiles/lumen`, { recursive: true });
  await Bun.write(`${rootDir}/profiles/lumen/profile.json`, JSON.stringify(testProfile(), null, 2));
  await Bun.write(`${rootDir}/config/codex.env`, "CODEX_HOME=./state/codex-home\n");
  await Bun.write(`${rootDir}/config/claude-settings.json`, JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }, null, 2));

  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    const { config } = await loadConfig("config/runtime.json");
    const adapter = config.adapters["codex-ollama"];
    expect(adapter.mode).toBe("agent-cli");
    if (adapter.mode !== "agent-cli") {
      throw new Error("expected agent-cli adapter");
    }
    expect(adapter.workingDir).toBe(rootDir);
    expect(adapter.envFile).toBe(path.join(rootDir, "config", "codex.env"));
    expect(adapter.settingsFile).toBe(path.join(rootDir, "config", "claude-settings.json"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("validateRuntimeConfig requires claude settings on trusted-vm adapters", async () => {
  const config = testConfig();
  config.adapters["claude-local"] = {
    mode: "agent-cli",
    driver: "claude-code",
    command: "claude",
    timeoutMs: 900000,
    autonomy: "trusted-vm"
  };

  const issues = await validateRuntimeConfig(config);

  expect(issues).toContain("claude-code trusted-vm adapter missing settingsFile for claude-local");
});

test("claimNextTask atomically claims the highest-priority eligible task and creates an attempt row", () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-claim.db`);
  const db = openDb(config);

  try {
    const low = enqueueTask(db, config, {
      kind: "low-priority",
      source: "operator:low",
      priority: 2,
      payload: {}
    });
    const high = enqueueTask(db, config, {
      kind: "high-priority",
      source: "operator:high",
      priority: 9,
      payload: {}
    });
    enqueueTask(db, config, {
      kind: "future",
      source: "operator:future",
      priority: 99,
      payload: {}
    });
    db.query(`
      UPDATE tasks
      SET available_at = ?
      WHERE source = 'operator:future'
    `).run("2999-01-01T00:00:00Z");

    const claim = claimNextTask(db, "runner-claim-test");

    expect(claim).not.toBeNull();
    expect(claim?.task.task_id).toBe(high.task_id);
    expect(claim?.task.status).toBe("running");
    expect(claim?.task.attempt_count).toBe(1);
    expect(claim?.task.task_id).not.toBe(low.task_id);
    expect(claim?.attempt.task_id).toBe(high.task_id);
    expect(claim?.attempt.runner_id).toBe("runner-claim-test");
    expect(claim?.attempt.status).toBe("running");

    const attempt = getTaskAttemptById(db, claim!.attempt.attempt_id);
    expect(attempt?.task_id).toBe(high.task_id);
    expect(attempt?.status).toBe("running");

    const claimEvent = getRecentRunEvents(db).find((event) => event.event_type === "task_claimed");
    expect(claimEvent?.task_id).toBe(high.task_id);
    expect(claimEvent?.attempt_id).toBe(claim?.attempt.attempt_id ?? null);
  } finally {
    db.close(false);
  }
});

test("simulated concurrent claim from separate DB connections does not duplicate the same task", () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-claim-concurrent.db`);
  const db1 = openDb(config);
  const db2 = openDb(config);

  try {
    const task = enqueueTask(db1, config, {
      kind: "single-claim",
      source: "operator:single-claim",
      priority: 7,
      payload: {}
    });

    const firstClaim = claimNextTask(db1, "runner-a");
    const secondClaim = claimNextTask(db2, "runner-b");

    expect(firstClaim?.task.task_id).toBe(task.task_id);
    expect(secondClaim).toBeNull();
    expect(getTaskAttemptsForTask(db1, task.task_id)).toHaveLength(1);
  } finally {
    db1.close(false);
    db2.close(false);
  }
});

test("cancelTaskByOperator marks a queued task operator_canceled and records an event", () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-operator-cancel.db`);
  const db = openDb(config);

  try {
    const task = enqueueTask(db, config, {
      kind: "operator",
      source: "operator:cancel-test",
      payload: {}
    });

    const canceled = cancelTaskByOperator(db, task.task_id, "operator changed direction");

    expect(canceled.status).toBe("operator_canceled");
    expect(canceled.outcome?.machine_status).toBe("canceled");
    expect(canceled.outcome?.operator_summary).toContain("operator changed direction");
    expect(getTaskCountsByStatus(db).operator_canceled).toBe(1);

    const event = getRecentRunEvents(db).find((entry) => entry.event_type === "task_operator_canceled");
    expect(event?.task_id).toBe(task.task_id);
    expect(event?.detail.previous_status).toBe("pending");
  } finally {
    db.close(false);
  }
});

test("cancelTaskByOperator rejects running and terminal tasks", () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-operator-cancel-running.db`);
  const db = openDb(config);

  try {
    const running = enqueueTask(db, config, {
      kind: "operator",
      source: "operator:running-cancel-test",
      payload: {}
    });
    claimNextTask(db, "runner-cancel-test");

    expect(() => cancelTaskByOperator(db, running.task_id, "stop")).toThrow("running task cancellation is not supported");

    const terminal = enqueueTask(db, config, {
      kind: "operator",
      source: "operator:terminal-cancel-test",
      payload: {}
    });
    finalizeTask(db, terminal.task_id, {
      status: "completed",
      operator_summary: "done",
      machine_status: "ok"
    });

    expect(() => cancelTaskByOperator(db, terminal.task_id, "stop")).toThrow("task is already terminal");
  } finally {
    db.close(false);
  }
});

test("compileBundle produces a stable bundle hash across retry-state changes for the same logical input", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-bundle-stable.db`);
  const db = openDb(config);
  const firstTask = testTaskRecord({
    task_id: "bundle-stable-task",
    requested_adapter: "ollama-qwen",
    payload: {
      proposal_artifact: "plans/runtime-hardening-plan.md"
    }
  });
  const secondTask = testTaskRecord({
    task_id: "bundle-stable-task",
    requested_adapter: "ollama-qwen",
    status: "retryable_failure",
    updated_at: "2026-04-10T00:05:00Z",
    attempt_count: 2,
    available_at: "2026-04-10T00:06:00Z",
    started_at: "2026-04-10T00:04:00Z",
    last_error: "temporary upstream failure",
    outcome: {
      status: "blocked",
      operator_summary: "prior attempt failed",
      machine_status: "blocked"
    },
    payload: {
      proposal_artifact: "plans/runtime-hardening-plan.md"
    }
  });
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n");

  try {
    const first = await compileBundle({
      db,
      config,
      task: firstTask,
      attemptId: "attempt-stable-1",
      profile: testProfile(),
      adapterId: "ollama-qwen",
      adapterConfig: config.adapters["ollama-qwen"]
    });
    const second = await compileBundle({
      db,
      config,
      task: secondTask,
      attemptId: "attempt-stable-2",
      profile: testProfile(),
      adapterId: "ollama-qwen",
      adapterConfig: config.adapters["ollama-qwen"]
    });

    expect(first.bundleRecord.bundle_hash).toBe(second.bundleRecord.bundle_hash);
  } finally {
    db.close(false);
  }
});

test("compileBundle marks dirty agent-cli workspaces as best_effort", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-bundle-agent-cli-dirty.db`);
  const db = openDb(config);
  const workspaceDir = `/tmp/test-runtime-workspace-${Date.now()}`;
  await mkdir(workspaceDir, { recursive: true });
  await Bun.$`git -c init.defaultBranch=main -C ${workspaceDir} init --quiet`;
  await Bun.write(path.join(workspaceDir, "dirty.txt"), "dirty\n");

  try {
    const adapterConfig = config.adapters["codex-ollama"];
    if (adapterConfig.mode !== "agent-cli") {
      throw new Error("expected codex-ollama agent-cli adapter");
    }
    const compiled = await compileBundle({
      db,
      config,
      task: testTaskRecord({
        task_id: "bundle-agent-cli-dirty-task",
        requested_adapter: "codex-ollama"
      }),
      attemptId: "attempt-agent-cli-dirty",
      profile: testProfile({ default_adapter: "codex-ollama" }),
      adapterId: "codex-ollama",
      adapterConfig: {
        ...adapterConfig,
        workingDir: workspaceDir
      }
    });

    expect(compiled.bundleRecord.replay_grade).toBe("best_effort");
  } finally {
    db.close(false);
  }
});

test("compileBundle changes bundle hash when a required input changes", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-bundle-diff.db`);
  const db = openDb(config);
  await writeTestArtifact(config, "plans/runtime-hardening-plan.md", "# Plan\n");

  try {
    const first = await compileBundle({
      db,
      config,
      task: testTaskRecord({
        task_id: "bundle-diff-task",
        description: "first description",
        requested_adapter: "ollama-qwen",
        payload: {
          proposal_artifact: "plans/runtime-hardening-plan.md"
        }
      }),
      attemptId: "attempt-diff-1",
      profile: testProfile(),
      adapterId: "ollama-qwen",
      adapterConfig: config.adapters["ollama-qwen"]
    });
    const second = await compileBundle({
      db,
      config,
      task: testTaskRecord({
        task_id: "bundle-diff-task",
        description: "second description",
        requested_adapter: "ollama-qwen",
        payload: {
          proposal_artifact: "plans/runtime-hardening-plan.md"
        }
      }),
      attemptId: "attempt-diff-2",
      profile: testProfile(),
      adapterId: "ollama-qwen",
      adapterConfig: config.adapters["ollama-qwen"]
    });

    expect(first.bundleRecord.bundle_hash).not.toBe(second.bundleRecord.bundle_hash);
  } finally {
    db.close(false);
  }
});

test("compileBundle marks uncached external input as best_effort", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-bundle-best-effort.db`);
  const db = openDb(config);

  try {
    const compiled = await compileBundle({
      db,
      config,
      task: testTaskRecord({
        task_id: "bundle-best-effort-task",
        requested_adapter: "ollama-qwen",
        payload: {
          external_inputs: [{ source: "https://example.com/status" }]
        }
      }),
      attemptId: "attempt-best-effort",
      profile: testProfile(),
      adapterId: "ollama-qwen",
      adapterConfig: config.adapters["ollama-qwen"]
    });

    expect(compiled.bundleRecord.replay_grade).toBe("best_effort");
  } finally {
    db.close(false);
  }
});

test("compileBundle marks agent-cli adapters as non_replayable_model", async () => {
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-bundle-remote-model.db`);
  const db = openDb(config);

  try {
    const compiled = await compileBundle({
      db,
      config,
      task: testTaskRecord({
        task_id: "bundle-remote-model-task",
        requested_adapter: "codex-ollama"
      }),
      attemptId: "attempt-remote-model",
      profile: testProfile({ default_adapter: "codex-ollama" }),
      adapterId: "codex-ollama",
      adapterConfig: config.adapters["codex-ollama"]
    });

    expect(compiled.bundleRecord.replay_grade).toBe("non_replayable_model");
  } finally {
    db.close(false);
  }
});

test("runOnce creates an attempt and bundle before adapter execution and links post-claim events", async () => {
  resetRuntimeForTests();
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-run-once-success.db`);
  const db = openDb(config);

  try {
    const queuedTask = enqueueTask(db, config, {
      kind: "runtime-improvement",
      source: "operator:run-once-success",
      requested_profile: "lumen",
      payload: {}
    });

    await withMockFetch(async () =>
      new Response(JSON.stringify({
        response: JSON.stringify({
          status: "completed",
          operator_summary: "executed successfully",
          machine_status: "ok"
        })
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
    async () => {
      const result = await runOnce(db, config);

      expect(result.ok).toBeTrue();
      expect(result.status).toBe("completed");

      const task = getTaskById(db, queuedTask.task_id);
      const attempts = getTaskAttemptsForTask(db, queuedTask.task_id);
      const attempt = attempts[0];
      const bundle = getBundleByAttemptId(db, attempt.attempt_id);
      const events = getRecentRunEvents(db).filter((event) => event.task_id === queuedTask.task_id);

      expect(task?.status).toBe("completed");
      expect(task?.outcome?.attempt_id).toBe(attempt.attempt_id);
      expect(task?.outcome?.bundle_id).toBe(bundle?.bundle_id);
      expect(attempts).toHaveLength(1);
      expect(attempt.status).toBe("finished");
      expect(attempt.bundle_id).toBe(bundle?.bundle_id ?? null);
      expect(bundle).not.toBeNull();
      expect(await Bun.file(path.join(config.artifactDir, bundle!.relative_path)).exists()).toBeTrue();
      expect(await Bun.file(path.join(config.artifactDir, bundle!.prompt_relative_path)).exists()).toBeTrue();

      const postClaimEvents = events.filter((event) =>
        ["task_claimed", "bundle_compiled", "task_attempt_finished", "task_finished"].includes(event.event_type)
      );
      expect(postClaimEvents).toHaveLength(4);
      expect(postClaimEvents.every((event) => event.attempt_id === attempt.attempt_id)).toBeTrue();
    });
  } finally {
    db.close(false);
  }
});

test("runOnce blocks the task and does not launch the adapter when bundle compilation fails", async () => {
  resetRuntimeForTests();
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-run-once-bundle-fail.db`);
  await mkdir(path.dirname(config.artifactDir), { recursive: true });
  await Bun.write(config.artifactDir, "artifact-dir-is-a-file");
  const db = openDb(config);
  let adapterLaunched = false;

  try {
    const queuedTask = enqueueTask(db, config, {
      kind: "runtime-improvement",
      source: "operator:run-once-bundle-fail",
      requested_profile: "lumen",
      payload: {}
    });

    await withMockFetch(async () => {
      adapterLaunched = true;
      return new Response(JSON.stringify({ response: "{}" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }, async () => {
      const result = await runOnce(db, config);

      expect(result.ok).toBeFalse();
      expect(result.status).toBe("blocked");
      expect(adapterLaunched).toBeFalse();

      const task = getTaskById(db, queuedTask.task_id);
      const attempt = getTaskAttemptsForTask(db, queuedTask.task_id)[0];
      expect(task?.status).toBe("blocked");
      expect(attempt.status).toBe("finished");
      expect(attempt.exit_status).toBe("error");
      expect(getBundleByAttemptId(db, attempt.attempt_id)).toBeNull();
    });
  } finally {
    db.close(false);
  }
});

test("runOnce closes the attempt and reschedules the task on retryable failure", async () => {
  resetRuntimeForTests();
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-run-once-retry.db`);
  const db = openDb(config);

  try {
    const queuedTask = enqueueTask(db, config, {
      kind: "runtime-improvement",
      source: "operator:run-once-retry",
      requested_profile: "lumen",
      payload: {}
    });

    await withMockFetch(async () =>
      new Response(JSON.stringify({ response: "temporary upstream failure" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      }),
    async () => {
      const result = await runOnce(db, config);

      expect(result.ok).toBeFalse();
      expect(result.status).toBe("retryable_failure");

      const task = getTaskById(db, queuedTask.task_id);
      const attempt = getTaskAttemptsForTask(db, queuedTask.task_id)[0];

      expect(task?.status).toBe("retryable_failure");
      expect(task?.outcome).toBeNull();
      expect(task?.last_error).toContain("temporary upstream failure");
      expect(attempt.status).toBe("finished");
      expect(attempt.exit_status).toBe("error");
      expect(attempt.retry_class).toBe("retryable");
    });
  } finally {
    db.close(false);
  }
});

test("runOnce boot sweep reclaims legacy running tasks and dangling attempts on startup", async () => {
  resetRuntimeForTests();
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-boot-sweep.db`);
  const db = openDb(config);

  try {
    const queuedTask = enqueueTask(db, config, {
      kind: "runtime-improvement",
      source: "operator:boot-sweep",
      requested_profile: "lumen",
      payload: {},
      max_attempts: 1
    });
    const timestamp = "2026-04-16T00:00:00Z";
    db.query(`
      UPDATE tasks
      SET status = 'running',
          attempt_count = 1,
          started_at = ?,
          updated_at = ?
      WHERE task_id = ?
    `).run(timestamp, timestamp, queuedTask.task_id);
    db.query(`
      INSERT INTO task_attempts (
        attempt_id, task_id, adapter_id, adapter_kind, model, runner_id, bundle_id, status,
        started_at, ended_at, exit_status, retry_class, prompt_path, stdout_path, stderr_path, result_path, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "boot-sweep-attempt",
      queuedTask.task_id,
      "ollama-qwen",
      "ollama-generate",
      "qwen3.5:35b",
      "runner-old",
      null,
      "running",
      timestamp,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    );

    const result = await runOnce(db, config);

    expect(result.ok).toBeTrue();
    expect(result.status).toBe("idle");

    const task = getTaskById(db, queuedTask.task_id);
    const attempt = getTaskAttemptById(db, "boot-sweep-attempt");
    expect(task?.status).toBe("retryable_failure");
    expect(task?.last_error).toBe("reclaimed on boot from prior running state");
    expect(attempt?.status).toBe("finished");
    expect(attempt?.retry_class).toBe("retryable");
    expect(attempt?.diagnostics?.reason).toBe("boot_sweep");

    const event = getRecentRunEvents(db).find((entry) => entry.event_type === "boot_sweep_reclaimed");
    expect(event?.detail.tasks_reclaimed).toBe(1);
    expect(event?.detail.attempts_reclaimed).toBe(1);
  } finally {
    db.close(false);
  }
});

test("openDb migrates legacy unique bundle_hash schema so identical hashes can be stored per attempt", () => {
  const dbPath = `/tmp/test-runtime-${Date.now()}-bundle-migration.db`;
  const config = testConfig(dbPath);
  const legacyDb = new Database(dbPath, { create: true });

  try {
    legacyDb.exec(`
      CREATE TABLE task_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        model TEXT,
        runner_id TEXT NOT NULL,
        bundle_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_status TEXT,
        retry_class TEXT,
        prompt_path TEXT,
        stdout_path TEXT,
        stderr_path TEXT,
        result_path TEXT,
        diagnostics_json TEXT
      );

      CREATE TABLE bundles (
        bundle_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        bundle_hash TEXT NOT NULL UNIQUE,
        agent_id TEXT,
        profile_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        model TEXT,
        variant_id TEXT,
        evaluator_version TEXT,
        replay_grade TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        prompt_relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (attempt_id) REFERENCES task_attempts(attempt_id)
      );
    `);
    legacyDb.query(`
      INSERT INTO task_attempts (
        attempt_id, task_id, adapter_id, adapter_kind, model, runner_id, bundle_id, status,
        started_at, ended_at, exit_status, retry_class, prompt_path, stdout_path, stderr_path, result_path, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("attempt-a", "task-a", "ollama-qwen", "ollama-generate", "qwen3.5:35b", "runner-a", null, "finished", "2026-04-10T00:00:00Z", "2026-04-10T00:00:01Z", "ok", "none", null, null, null, null, null);
    legacyDb.query(`
      INSERT INTO task_attempts (
        attempt_id, task_id, adapter_id, adapter_kind, model, runner_id, bundle_id, status,
        started_at, ended_at, exit_status, retry_class, prompt_path, stdout_path, stderr_path, result_path, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("attempt-b", "task-a", "ollama-qwen", "ollama-generate", "qwen3.5:35b", "runner-a", null, "finished", "2026-04-10T00:01:00Z", "2026-04-10T00:01:01Z", "ok", "none", null, null, null, null, null);
  } finally {
    legacyDb.close(false);
  }

  const db = openDb(config);
  try {
    db.query(`
      INSERT INTO bundles (
        bundle_id, task_id, attempt_id, bundle_hash, agent_id, profile_id, adapter_id, model,
        variant_id, evaluator_version, replay_grade, relative_path, prompt_relative_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "bundle-a",
      "task-a",
      "attempt-a",
      "shared-hash",
      "test-runtime",
      "lumen",
      "ollama-qwen",
      "qwen3.5:35b",
      null,
      null,
      "inputs_frozen",
      "bundles/2026-04-10/bundle-a.json",
      "bundles/2026-04-10/bundle-a.prompt.txt",
      "2026-04-10T00:00:00Z"
    );
    db.query(`
      INSERT INTO bundles (
        bundle_id, task_id, attempt_id, bundle_hash, agent_id, profile_id, adapter_id, model,
        variant_id, evaluator_version, replay_grade, relative_path, prompt_relative_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "bundle-b",
      "task-a",
      "attempt-b",
      "shared-hash",
      "test-runtime",
      "lumen",
      "ollama-qwen",
      "qwen3.5:35b",
      null,
      null,
      "inputs_frozen",
      "bundles/2026-04-10/bundle-b.json",
      "bundles/2026-04-10/bundle-b.prompt.txt",
      "2026-04-10T00:01:00Z"
    );

    const duplicates = db.query(`
      SELECT COUNT(*) AS count
      FROM bundles
      WHERE bundle_hash = 'shared-hash'
    `).get() as { count: number };

    expect(duplicates.count).toBe(2);
  } finally {
    db.close(false);
  }
});

test("openDb migrates legacy run_events schemas before creating attempt-aware indexes", () => {
  const dbPath = `/tmp/test-runtime-${Date.now()}-run-events-migration.db`;
  const config = testConfig(dbPath);
  const legacyDb = new Database(dbPath, { create: true });

  try {
    legacyDb.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        priority INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        requested_profile TEXT NOT NULL,
        requested_adapter TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        outcome_json TEXT,
        last_error TEXT
      );

      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        task_id TEXT,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template TEXT NOT NULL,
        instance_key TEXT NOT NULL UNIQUE,
        current_state TEXT NOT NULL,
        context_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
  } finally {
    legacyDb.close(false);
  }

  const db = openDb(config);
  try {
    const runEventColumns = db.query("PRAGMA table_info(run_events)").all() as Array<{ name: string }>;
    const runEventIndexes = db.query("PRAGMA index_list(run_events)").all() as Array<{ name: string }>;
    const taskAttemptColumns = db.query("PRAGMA table_info(task_attempts)").all() as Array<{ name: string }>;

    expect(runEventColumns.some((column) => column.name === "attempt_id")).toBeTrue();
    expect(runEventIndexes.some((index) => index.name === "idx_run_events_task_attempt")).toBeTrue();
    expect(taskAttemptColumns.some((column) => column.name === "attempt_id")).toBeTrue();
  } finally {
    db.close(false);
  }
});

test("runOnce clears a stale dispatch lock whose recorded PID is not live", async () => {
  resetRuntimeForTests();
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-stale-lock.db`);
  const db = openDb(config);
  await mkdir(path.dirname(config.lockPath), { recursive: true });
  await Bun.write(config.lockPath, JSON.stringify({
    pid: 999999,
    runner_id: "runner-stale",
    created_at: "2026-04-16T00:00:00Z"
  }));

  try {
    const result = await runOnce(db, config);

    expect(result.ok).toBeTrue();
    expect(result.status).toBe("idle");

    const event = getRecentRunEvents(db).find((entry) => entry.event_type === "dispatch_lock_stale_cleared");
    expect(event).not.toBeUndefined();
    expect(event?.detail.reason).toBe("pid_not_live");
    expect(event?.detail.previous_runner_id).toBe("runner-stale");
  } finally {
    db.close(false);
  }
});

test("runOnce no-ops while dispatch is paused", async () => {
  resetRuntimeForTests();
  const config = testConfig(`/tmp/test-runtime-${Date.now()}-dispatch-paused.db`);
  const db = openDb(config);

  try {
    const task = enqueueTask(db, config, {
      kind: "operator",
      source: "operator:pause-test",
      payload: {}
    });
    const pause = writeDispatchPause(config, true, "maintenance window");
    expect(pause.paused).toBeTrue();
    expect(readDispatchPause(config).reason).toBe("maintenance window");

    const result = await runOnce(db, config);

    expect(result.ok).toBeTrue();
    expect(result.status).toBe("paused");
    expect(getTaskById(db, task.task_id)?.status).toBe("pending");

    const event = getRecentRunEvents(db).find((entry) => entry.event_type === "dispatch_paused");
    expect(event?.detail.reason).toBe("maintenance window");

    const resumed = writeDispatchPause(config, false);
    expect(resumed.paused).toBeFalse();
    expect(readDispatchPause(config).paused).toBeFalse();
  } finally {
    db.close(false);
  }
});

function testConfig(dbPath = ":memory:"): RuntimeConfig {
  const baseName = dbPath === ":memory:"
    ? "test-runtime-memory"
    : path.basename(dbPath, path.extname(dbPath));
  const rootDir = `/tmp/${baseName}`;

  return {
    runtimeName: "test-runtime",
    runtimePolicy: "test",
    stateDir: `${rootDir}/state`,
    logDir: `${rootDir}/logs`,
    artifactDir: `${rootDir}/artifacts`,
    dbPath,
    lockPath: `${rootDir}/lock`,
    defaultProfile: "lumen",
    defaultAdapter: "ollama-qwen",
    maxAttempts: 3,
    retryBackoffSeconds: 30,
    profiles: { lumen: "profiles/lumen/profile.json" },
    adapters: {
      "ollama-qwen": {
        mode: "ollama-generate",
        endpoint: "http://127.0.0.1:11434",
        model: "qwen3.5:35b",
        timeoutMs: 60000
      },
      "codex-ollama": {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        model: "qwen3.5:35b",
        timeoutMs: 900000,
        workingDir: rootDir,
        sandbox: "workspace-write",
        env: {
          CODEX_HOME: `${rootDir}/codex-home`
        },
        providerId: "ollama_remote",
        providerName: "Ollama Remote",
        providerBaseUrl: "http://192.168.1.69:11434/v1",
        providerWireApi: "responses",
        providerRequiresOpenAIAuth: false
      }
    }
  };
}

function testProfile(overrides: Partial<ReturnType<typeof testProfileBase>> = {}) {
  return {
    ...testProfileBase(),
    ...overrides,
    context_policy: {
      ...testProfileBase().context_policy,
      ...(overrides.context_policy ?? {})
    }
  };
}

function testProfileBase() {
  return {
    profile_id: "lumen",
    style: "codex-like" as const,
    role: "runtime hardening",
    system_prompt_parts: ["Stay deterministic."],
    skills: ["runtime"],
    default_adapter: "ollama-qwen",
    tool_policy: {},
    context_policy: {
      include_recent_task_memory: true,
      max_prompt_chars: 16000
    },
    result_schema: {},
    integration_policies: {}
  };
}

function testTaskRecord(overrides: Partial<Parameters<typeof assembleContext>[2]>) {
  return {
    task_id: "test-task",
    kind: "goal-plan",
    source: "workflow:1:plan",
    subject: "Test task",
    description: "Test description",
    priority: 5,
    payload: {},
    requested_profile: "lumen",
    requested_adapter: "ollama-qwen",
    status: "pending" as const,
    created_at: "2026-04-10T00:00:00Z",
    updated_at: "2026-04-10T00:00:00Z",
    attempt_count: 0,
    max_attempts: 3,
    available_at: "2026-04-10T00:00:00Z",
    started_at: null,
    finished_at: null,
    outcome: null,
    last_error: null,
    ...overrides
  };
}

async function writeTestArtifact(config: RuntimeConfig, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(config.artifactDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await Bun.write(fullPath, content);
}

async function withMockFetch<T>(
  responder: () => Promise<Response> | Response,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => await responder()) as unknown as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("workflow evaluation advances from a completed research state", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "community-research",
      instance_key: "lumen-community-wiki",
      current_state: "discover-aibtc-basics",
      context_json: JSON.stringify({ topic: "AIBTC community wiki" })
    });

    const task = enqueueTask(db, config, {
      kind: "community-research",
      source: `workflow:${workflowId}:discover-aibtc-basics`,
      payload: { topic: "AIBTC community wiki" },
      requested_profile: "lumen"
    });

    finalizeTask(db, task.task_id, {
      status: "completed",
      operator_summary: "completed",
      machine_status: "ok"
    });

    const result = evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-community-wiki");

    expect(result.workflowsEvaluated).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(workflow?.current_state).toBe("draft-community-wiki-outline");
    expect(getAllActiveWorkflows(db)).toHaveLength(1);
  } finally {
    db.close(false);
  }
});

test("goal loop plan advances directly to execute after a completed plan task", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "goal-loop",
      instance_key: "lumen-goal-loop",
      current_state: "plan",
      context_json: JSON.stringify({
        summary: "Ship builder mode",
        plan_artifact: "plans/2026-04-11T00-00-00-000Z-ship-builder-mode-plan.md",
        execution_iteration: 1
      })
    });

    const task = enqueueTask(db, config, {
      kind: "goal-plan",
      source: `workflow:${workflowId}:plan`,
      payload: {
        proposal_artifact: "plans/2026-04-11T00-00-00-000Z-ship-builder-mode-plan.md"
      },
      requested_profile: "lumen"
    });

    finalizeTask(db, task.task_id, {
      status: "completed",
      operator_summary: "plan ready",
      machine_status: "ok"
    });

    const result = evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-goal-loop");

    expect(result.workflowsEvaluated).toBe(1);
    expect(workflow?.current_state).toBe("execute");
  } finally {
    db.close(false);
  }
});

test("workflow evaluation does not retry an operator-canceled workflow task", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "goal-loop",
      instance_key: "lumen-goal-loop-canceled",
      current_state: "execute",
      context_json: JSON.stringify({
        summary: "Ship builder mode",
        plan_artifact: "plans/ship-builder-mode-plan.md",
        execution_iteration: 1
      })
    });

    const task = enqueueTask(db, config, {
      kind: "goal-execute",
      source: `workflow:${workflowId}:execute`,
      payload: {
        proposal_artifact: "plans/ship-builder-mode-plan.md"
      },
      requested_profile: "lumen"
    });
    cancelTaskByOperator(db, task.task_id, "operator paused the lane");

    const result = evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-goal-loop-canceled");
    const events = getRecentRunEvents(db);

    expect(result.workflowsEvaluated).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(workflow?.current_state).toBe("execute");
    expect(events.some((event) => event.event_type === "workflow_state_operator_canceled")).toBe(true);
  } finally {
    db.close(false);
  }
});

test("goal loop verify advances from recorded raw outcome status, not summary text", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "goal-loop",
      instance_key: "lumen-goal-loop-raw-approved",
      current_state: "verify",
      context_json: JSON.stringify({
        summary: "Ship builder mode",
        plan_artifact: "plans/ship-builder-mode-plan.md",
        execution_iteration: 1
      })
    });

    const task = enqueueTask(db, config, {
      kind: "goal-verify",
      source: `workflow:${workflowId}:verify`,
      payload: {
        proposal_artifact: "plans/ship-builder-mode-plan.md",
        accepted_signals: ["continue", "complete", "revise_plan"]
      },
      requested_profile: "lumen"
    });

    finalizeTask(db, task.task_id, {
      status: "completed",
      operator_summary: "This text does not contain the transition keyword.",
      machine_status: "ok",
      raw_output: JSON.stringify({
        status: "continue",
        operator_summary: "Continue with the next execution slice",
        machine_status: "ok"
      })
    });

    evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-goal-loop-raw-approved");

    expect(workflow?.current_state).toBe("execute");
    expect(JSON.parse(workflow?.context_json ?? "{}").last_workflow_signal).toBe("continue");
  } finally {
    db.close(false);
  }
});

test("goal loop verify continues from recorded raw outcome status", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "goal-loop",
      instance_key: "lumen-goal-loop-continue",
      current_state: "verify",
      context_json: JSON.stringify({
        summary: "Ship builder mode",
        plan_artifact: "plans/ship-builder-mode-plan.md",
        execution_iteration: 2
      })
    });

    const task = enqueueTask(db, config, {
      kind: "goal-verify",
      source: `workflow:${workflowId}:verify`,
      payload: {
        proposal_artifact: "plans/ship-builder-mode-plan.md",
        accepted_signals: ["continue", "complete", "revise_plan"]
      },
      requested_profile: "lumen"
    });

    finalizeTask(db, task.task_id, {
      status: "completed",
      operator_summary: "Verification finished without using signal words here.",
      machine_status: "ok",
      raw_output: JSON.stringify({
        status: "continue",
        operator_summary: "Continue with the next execution slice"
      })
    });

    evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-goal-loop-continue");
    const context = JSON.parse(workflow?.context_json ?? "{}");

    expect(workflow?.current_state).toBe("execute");
    expect(context.execution_iteration).toBe(3);
    expect(context.last_workflow_signal).toBe("continue");
  } finally {
    db.close(false);
  }
});

test("goal loop verify revises plan from recorded raw outcome status", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "goal-loop",
      instance_key: "lumen-goal-loop-revise-plan",
      current_state: "verify",
      context_json: JSON.stringify({
        summary: "Ship builder mode",
        plan_artifact: "plans/ship-builder-mode-plan.md",
        execution_iteration: 2
      })
    });

    const task = enqueueTask(db, config, {
      kind: "goal-verify",
      source: `workflow:${workflowId}:verify`,
      payload: {
        proposal_artifact: "plans/ship-builder-mode-plan.md",
        accepted_signals: ["continue", "complete", "revise_plan"]
      },
      requested_profile: "lumen"
    });

    finalizeTask(db, task.task_id, {
      status: "completed",
      operator_summary: "The summary is intentionally misleading and should not drive transitions.",
      machine_status: "ok",
      raw_output: JSON.stringify({
        status: "revise_plan",
        operator_summary: "Execution found a plan gap"
      })
    });

    evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-goal-loop-revise-plan");
    const context = JSON.parse(workflow?.context_json ?? "{}");

    expect(workflow?.current_state).toBe("plan");
    expect(context.execution_iteration).toBe(2);
    expect(context.last_workflow_signal).toBe("revise_plan");
  } finally {
    db.close(false);
  }
});

test("goal loop verify completes from recorded raw outcome status", () => {
  const config = testConfig();
  const db = openDb(config);

  try {
    const workflowId = insertWorkflow(db, {
      template: "goal-loop",
      instance_key: "lumen-goal-loop-complete",
      current_state: "verify",
      context_json: JSON.stringify({
        summary: "Ship builder mode",
        plan_artifact: "plans/ship-builder-mode-plan.md",
        execution_iteration: 2
      })
    });

    const task = enqueueTask(db, config, {
      kind: "goal-verify",
      source: `workflow:${workflowId}:verify`,
      payload: {
        proposal_artifact: "plans/ship-builder-mode-plan.md",
        accepted_signals: ["continue", "complete", "revise_plan"]
      },
      requested_profile: "lumen"
    });

    finalizeTask(db, task.task_id, {
      status: "completed",
      operator_summary: "Ignore this summary text too.",
      machine_status: "ok",
      raw_output: JSON.stringify({
        status: "complete",
        operator_summary: "Execution is complete"
      })
    });

    evaluateActiveWorkflows(db, config);
    const workflow = getWorkflowByInstanceKey(db, "lumen-goal-loop-complete");
    const active = getAllActiveWorkflows(db).find((item) => item.id === workflowId);

    expect(workflow?.current_state).toBe("complete");
    expect(workflow?.completed_at).not.toBeNull();
    expect(active).toBeUndefined();
  } finally {
    db.close(false);
  }
});

test("compareSnapshots reports workflow state changes and new artifacts", () => {
  const before = {
    captured_at: "2026-04-10T23:10:32.418Z",
    runtime_name: "lumen",
    status: {
      counts: [
        { status: "completed", count: 4 },
        { status: "pending", count: 8 }
      ],
      recent: [],
      lastEvent: { event_type: "workflow_evaluation" }
    },
    workflows: [
      {
        id: 1,
        template: "community-research",
        instance_key: "lumen-community-wiki",
        current_state: "discover-aibtc-basics",
        created_at: "2026-04-10T23:00:00Z",
        updated_at: "2026-04-10T23:00:00Z",
        completed_at: null,
        context: null
      }
    ],
    active_workflows: [
      {
        id: 1,
        template: "community-research",
        instance_key: "lumen-community-wiki",
        current_state: "discover-aibtc-basics",
        created_at: "2026-04-10T23:00:00Z",
        updated_at: "2026-04-10T23:00:00Z",
        completed_at: null,
        context: null
      }
    ],
    queued_tasks: [{ task_id: "a", status: "pending" }],
    recent_completed: [],
    artifact_files: ["community-wiki/aibtc-basics.md"]
  };

  const after = {
    captured_at: "2026-04-11T02:44:51.360Z",
    runtime_name: "lumen",
    status: {
      counts: [
        { status: "completed", count: 12 },
        { status: "pending", count: 0 }
      ],
      recent: [],
      lastEvent: { event_type: "dispatch_idle" }
    },
    workflows: [
      {
        id: 1,
        template: "community-research",
        instance_key: "lumen-community-wiki",
        current_state: "draft-community-wiki-outline",
        created_at: "2026-04-10T23:00:00Z",
        updated_at: "2026-04-11T00:00:00Z",
        completed_at: null,
        context: null
      }
    ],
    active_workflows: [
      {
        id: 1,
        template: "community-research",
        instance_key: "lumen-community-wiki",
        current_state: "draft-community-wiki-outline",
        created_at: "2026-04-10T23:00:00Z",
        updated_at: "2026-04-11T00:00:00Z",
        completed_at: null,
        context: null
      }
    ],
    queued_tasks: [],
    recent_completed: [],
    artifact_files: [
      "community-wiki/aibtc-basics.md",
      "community-wiki/outline.md"
    ]
  };

  const report = compareSnapshots(before, after);

  expect(report.completed_task_delta).toEqual({ before: 4, after: 12, delta: 8 });
  expect(report.queued_task_delta).toEqual({ before: 1, after: 0, delta: -1 });
  expect(report.new_artifacts_created).toEqual(["community-wiki/outline.md"]);
  expect(report.workflow_state_changes).toEqual([
    {
      instance_key: "lumen-community-wiki",
      change: "advanced",
      template: "community-research",
      from_state: "discover-aibtc-basics",
      to_state: "draft-community-wiki-outline",
      completed_at: null
    }
  ]);
  expect(report.ended_idle).toBe(true);
});

test("buildAgentCliInvocation loads export-prefixed env files", async () => {
  const rootDir = `/tmp/agent-cli-env-${Date.now()}`;
  await mkdir(rootDir, { recursive: true });
  await Bun.write(`${rootDir}/codex.env`, "export CODEX_HOME=./state/codex-home\n");

  const invocation = buildAgentCliInvocation(
    {
      task: testTaskRecord({ task_id: "codex-env-task", requested_adapter: "codex-ollama" }),
      attempt: {
        attempt_id: "attempt-codex-env-task",
        task_id: "codex-env-task",
        adapter_id: "codex-ollama",
        adapter_kind: "agent-cli",
        model: "qwen3.6:35b",
        runner_id: "runner-test",
        bundle_id: "bundle-codex-env-task",
        status: "running",
        started_at: "2026-04-10T00:00:00Z",
        ended_at: null,
        exit_status: null,
        retry_class: null,
        prompt_path: null,
        stdout_path: null,
        stderr_path: null,
        result_path: null,
        diagnostics: null
      },
      bundle: {
        bundle_id: "bundle-codex-env-task",
        task_id: "codex-env-task",
        attempt_id: "attempt-codex-env-task",
        bundle_hash: "bundle-hash-codex-env-task",
        agent_id: "test-runtime",
        profile_id: "lumen",
        adapter_id: "codex-ollama",
        model: "qwen3.6:35b",
        variant_id: null,
        evaluator_version: null,
        replay_grade: "non_replayable_model",
        relative_path: "bundles/2026-04-10/bundle-codex-env-task.json",
        prompt_relative_path: "bundles/2026-04-10/bundle-codex-env-task.prompt.txt",
        created_at: "2026-04-10T00:00:00Z"
      },
      profile: testProfile(),
      adapterId: "codex-ollama",
      adapterConfig: {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        model: "qwen3.6:35b",
        timeoutMs: 900000,
        workingDir: rootDir,
        envFile: `${rootDir}/codex.env`
      },
      runtimeConfig: testConfig(),
      assembledContext: "Return JSON."
    },
    {
      mode: "agent-cli",
      driver: "codex",
      command: "codex",
      model: "qwen3.6:35b",
      timeoutMs: 900000,
      workingDir: rootDir,
      envFile: `${rootDir}/codex.env`
    },
    "/tmp/last-message.txt"
  );

  expect(invocation.env.CODEX_HOME).toBe("./state/codex-home");
});

test("claude-like context includes trusted-vm execution guidance", async () => {
  const config = testConfig();
  const profile = { ...testProfile(), profile_id: "claude", style: "claude-like" as const };
  const context = await assembleContext(config, profile, testTaskRecord({}));

  expect(context).toContain("Start by using Claude Code tools and shell commands");
  expect(context).toContain("do not stop to ask for permissions if the adapter was launched in bypass mode");
});

test("hermes-like context includes trusted-vm execution guidance", async () => {
  const config = testConfig();
  const profile = { ...testProfile(), profile_id: "hermes", style: "hermes-like" as const };
  const context = await assembleContext(config, profile, testTaskRecord({}));

  expect(context).toContain("Start by using Hermes terminal and file tools");
  expect(context).toContain("do not stop for dangerous-command approvals if the adapter was launched with --yolo");
});

test("loadConfig keeps inherited relative paths anchored to the parent config", async () => {
  const rootDir = `/tmp/load-config-parent-anchored-${Date.now()}`;
  const hostDir = `/tmp/load-config-parent-anchored-host-${Date.now()}`;
  await mkdir(`${rootDir}/config`, { recursive: true });
  await mkdir(`${rootDir}/profiles/lumen`, { recursive: true });
  await mkdir(hostDir, { recursive: true });
  await Bun.write(`${rootDir}/config/runtime.json`, JSON.stringify({
    runtimeName: "test",
    runtimePolicy: "test",
    stateDir: "./state",
    logDir: "./state/logs",
    artifactDir: "./state/artifacts",
    dbPath: "./state/runtime.db",
    lockPath: "./state/dispatch.lock",
    defaultProfile: "lumen",
    defaultAdapter: "codex-ollama",
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    profiles: {
      lumen: "../profiles/lumen/profile.json"
    },
    adapters: {
      "codex-ollama": {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        timeoutMs: 900000,
        workingDir: "..",
        envFile: "./codex.env"
      }
    }
  }, null, 2));
  await Bun.write(`${rootDir}/profiles/lumen/profile.json`, JSON.stringify(testProfile(), null, 2));
  await Bun.write(`${rootDir}/config/codex.env`, "CODEX_HOME=./state/codex-home\n");
  await Bun.write(`${hostDir}/runtime.host.json`, JSON.stringify({
    extends: `${rootDir}/config/runtime.json`,
    defaultAdapter: "codex-ollama"
  }, null, 2));

  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    const { config } = await loadConfig(`${hostDir}/runtime.host.json`);
    expect(config.profiles.lumen).toBe(path.join(rootDir, "profiles", "lumen", "profile.json"));
    const adapter = config.adapters["codex-ollama"];
    expect(adapter.mode).toBe("agent-cli");
    if (adapter.mode !== "agent-cli") {
      throw new Error("expected agent-cli adapter");
    }
    expect(adapter.workingDir).toBe(rootDir);
    expect(adapter.envFile).toBe(path.join(rootDir, "config", "codex.env"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("loadConfig merges sibling override configs", async () => {
  const rootDir = `/tmp/load-config-extends-${Date.now()}`;
  await mkdir(`${rootDir}/config`, { recursive: true });
  await mkdir(`${rootDir}/profiles/lumen`, { recursive: true });
  await Bun.write(`${rootDir}/profiles/lumen/profile.json`, JSON.stringify(testProfile(), null, 2));
  await Bun.write(`${rootDir}/config/codex.env`, "CODEX_HOME=./state/codex-home\n");
  await Bun.write(`${rootDir}/config/claude.env`, "export ANTHROPIC_MODEL=qwen3.6:35b\n");
  await Bun.write(`${rootDir}/config/claude-settings.json`, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2));
  await Bun.write(`${rootDir}/config/runtime.base.json`, JSON.stringify({
    runtimeName: "test",
    runtimePolicy: "test",
    stateDir: "./state",
    logDir: "./state/logs",
    artifactDir: "./state/artifacts",
    dbPath: "./state/runtime.db",
    lockPath: "./state/dispatch.lock",
    defaultProfile: "lumen",
    defaultAdapter: "codex-ollama",
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    profiles: {
      lumen: "../profiles/lumen/profile.json"
    },
    adapters: {
      "codex-ollama": {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        timeoutMs: 900000,
        workingDir: "..",
        envFile: "./codex.env"
      }
    }
  }, null, 2));
  await Bun.write(`${rootDir}/config/runtime.override.json`, JSON.stringify({
    extends: "./runtime.base.json",
    defaultAdapter: "claude-ollama",
    adapters: {
      "claude-ollama": {
        mode: "agent-cli",
        driver: "claude-code",
        command: "/home/dev/.local/bin/claude",
        timeoutMs: 900000,
        workingDir: ".",
        envFile: "./claude.env",
        settingsFile: "./claude-settings.json",
        autonomy: "trusted-vm"
      }
    }
  }, null, 2));

  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    const { config } = await loadConfig("config/runtime.override.json");
    expect(config.defaultAdapter).toBe("claude-ollama");
    expect(config.adapters["codex-ollama"]).toBeDefined();
    expect(config.adapters["claude-ollama"]).toBeDefined();
    const adapter = config.adapters["claude-ollama"];
    expect(adapter.mode).toBe("agent-cli");
    if (adapter.mode !== "agent-cli") {
      throw new Error("expected agent-cli adapter");
    }
    expect(adapter.command).toBe("/home/dev/.local/bin/claude");
    expect(adapter.envFile).toBe(`${rootDir}/config/claude.env`);
    expect(adapter.settingsFile).toBe(`${rootDir}/config/claude-settings.json`);
    expect(adapter.autonomy).toBe("trusted-vm");
  } finally {
    process.chdir(previousCwd);
  }
});
