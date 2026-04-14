import { expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { normalizeCanonicalOutcome, validateProfile, verifyCompletedTaskOutcome, verifyTaskInputArtifacts } from "./validation";
import { githubEventToTask } from "./bridges/github";
import { discordEventToTask } from "./bridges/discord";
import { buildWorkflowTaskInput, getTemplateByName } from "./workflows";
import { compareSnapshots } from "./report";
import { enqueueTask, enqueueTaskIfNew, finalizeTask, getAllActiveWorkflows, getWorkflowByInstanceKey, insertWorkflow, openDb } from "./db";
import { evaluateActiveWorkflows } from "./workflow-runtime";
import type { RuntimeConfig } from "./types";
import { writeArtifactIfNeeded } from "./artifacts";
import { assembleContext } from "./context";
import { buildAgentCliInvocation } from "./adapters/cli";
import { loadConfig } from "./config";

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
  const profile = testProfile({ context_policy: { include_recent_task_memory: true, max_prompt_chars: 1800 } });
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

  expect(context.length).toBeLessThanOrEqual(1800);
  expect(context).toContain("Approved plan artifact: plans/runtime-hardening-plan.md");
  expect(context).not.toContain("tail");
});

test("buildAgentCliInvocation constructs codex exec command for ollama responses provider", () => {
  const invocation = buildAgentCliInvocation(
    {
      task: testTaskRecord({
        task_id: "codex-task",
        requested_adapter: "codex-ollama"
      }),
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
        env: {
          CODEX_HOME: "./state/codex-home"
        }
      },
      runtimeConfig: testConfig(),
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
  expect(invocation.args).toContain("/tmp/last-message.txt");
  expect(invocation.args).toContain(`model="qwen3.5:35b"`);
  expect(invocation.args).toContain(`model_provider="ollama_remote"`);
  expect(invocation.args).toContain(`model_providers.ollama_remote={name="Ollama Remote",base_url="http://192.168.1.69:11434/v1",wire_api="responses",requires_openai_auth=false}`);
  expect(invocation.args.at(-1)).toBe("-");
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
      lumen: "./profiles/lumen/profile.json"
    },
    adapters: {
      "codex-ollama": {
        mode: "agent-cli",
        driver: "codex",
        command: "codex",
        timeoutMs: 900000,
        workingDir: ".",
        envFile: "./config/codex.env"
      }
    }
  }, null, 2));
  await mkdir(`${rootDir}/profiles/lumen`, { recursive: true });
  await Bun.write(`${rootDir}/profiles/lumen/profile.json`, JSON.stringify(testProfile(), null, 2));
  await Bun.write(`${rootDir}/config/codex.env`, "CODEX_HOME=./state/codex-home\n");

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
    expect(adapter.envFile).toBe(path.join(rootDir, "config/codex.env"));
  } finally {
    process.chdir(previousCwd);
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
