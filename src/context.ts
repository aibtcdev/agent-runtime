import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import canonicalize from "canonicalize";
import type { Database } from "bun:sqlite";
import { getWorkflowById } from "./db";
import type { AdapterConfig, BundleArtifactRecord, Profile, ReplayGrade, TaskRecord, RuntimeConfig } from "./types";
import { loadLessonsForTopic } from "./memory";

const MAX_PAYLOAD_CHARS = 4000;

function sanitizeRelativeArtifactPath(value: string): string {
  return value
    .replace(/^\/+/, "")
    .replace(/^state\/artifacts\/+/, "")
    .replace(/\.\./g, "")
    .trim();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readPositiveInteger(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}\n[truncated]\n`;
}

function summarizeJson(value: Record<string, unknown>): string {
  return truncateText(JSON.stringify(value, null, 2), MAX_PAYLOAD_CHARS);
}

function buildBundleTaskSnapshot(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.task_id,
    kind: task.kind,
    source: task.source,
    subject: task.subject,
    description: task.description,
    priority: task.priority,
    payload: task.payload,
    requested_profile: task.requested_profile,
    requested_adapter: task.requested_adapter,
    created_at: task.created_at,
    max_attempts: task.max_attempts,
    lesson_topic: task.lesson_topic
  };
}

function resolveArtifactFilePath(config: RuntimeConfig, artifactPath: string | null): string | null {
  if (!artifactPath) {
    return null;
  }
  const relativePath = sanitizeRelativeArtifactPath(artifactPath);
  if (!relativePath) {
    return null;
  }
  return path.join(config.artifactDir, relativePath);
}

function readArtifactSummary(config: RuntimeConfig, artifactPath: string): string | null {
  const relativePath = sanitizeRelativeArtifactPath(artifactPath);
  if (!relativePath) {
    return null;
  }
  const fullPath = path.join(config.artifactDir, relativePath);
  if (!existsSync(fullPath)) {
    return `Artifact missing: ${relativePath}`;
  }
  return null;
}

function deriveGoalLoopBaseName(proposalArtifact: string | null): string | null {
  if (!proposalArtifact) {
    return null;
  }
  const filename = proposalArtifact.split("/").pop() ?? "";
  if (!filename.endsWith("-plan.md")) {
    return null;
  }
  return filename.slice(0, -"-plan.md".length);
}

function resolveLatestGoalLoopVerificationArtifact(
  config: RuntimeConfig,
  proposalArtifact: string | null,
  iteration: number
): string | null {
  const baseName = deriveGoalLoopBaseName(proposalArtifact);
  if (!baseName) {
    return null;
  }

  const candidates: string[] = [];
  for (let current = iteration - 1; current >= 1; current -= 1) {
    candidates.push(`reports/${baseName}-verify-${current}.md`);
  }

  for (const candidate of candidates) {
    const fullPath = path.join(config.artifactDir, sanitizeRelativeArtifactPath(candidate));
    if (existsSync(fullPath)) {
      return candidate;
    }
  }

  return null;
}

function appendArtifactReferenceSection(
  lines: string[],
  config: RuntimeConfig,
  title: string,
  artifactPath: string | null
): void {
  if (!artifactPath) {
    return;
  }

  const relativePath = sanitizeRelativeArtifactPath(artifactPath);
  const resolvedPath = resolveArtifactFilePath(config, artifactPath);
  lines.push(`${title}: ${relativePath}`);
  if (resolvedPath) {
    lines.push(`- On disk: ${resolvedPath}`);
  }
  lines.push("");
}

function buildGoalLoopContextLines(config: RuntimeConfig, task: TaskRecord): string[] {
  const phase = readString(task.payload.phase);
  if (!phase) {
    return [];
  }

  const objective = readString(task.payload.objective) ?? "workflow goal";
  const scope = readStringArray(task.payload.scope);
  const proposalArtifact = readString(task.payload.proposal_artifact);
  const implementationArtifact = readString(task.payload.implementation_artifact);
  const iteration = readPositiveInteger(task.payload.iteration, 1);
  const lines = [
    "Workflow context:",
    `- Phase: ${phase}`,
    `- Objective: ${objective}`,
    `- Scope: ${scope.join(", ") || "none declared"}`,
    `- Artifact root on disk: ${config.artifactDir}`,
    ""
  ];

  if (phase === "plan") {
    return lines;
  }

  if (phase === "execute") {
    lines.push("Execution guidance:");
    lines.push("- Read the approved plan directly from disk during this run.");
    lines.push("- Artifact paths like plans/... and reports/... are relative to the artifact root above, not the repo root.");
    lines.push("- Do not treat prior artifact summaries as proof. Use direct file reads and command output.");
    lines.push("");
    appendArtifactReferenceSection(lines, config, "Approved plan artifact", proposalArtifact);
    appendArtifactReferenceSection(
      lines,
      config,
      "Latest verification artifact",
      resolveLatestGoalLoopVerificationArtifact(config, proposalArtifact, iteration)
    );
    return lines;
  }

  if (phase === "verify") {
    lines.push("Verification guidance:");
    lines.push("- Use current-run shell commands, adapter audit bundles, and direct file reads as the source of truth.");
    lines.push("- Treat prior artifact summaries as historical context only.");
    lines.push("- Artifact paths like plans/... and reports/... are relative to the artifact root above, not the repo root.");
    lines.push("- If current-run evidence contradicts an older artifact summary, trust the current-run evidence and explain the contradiction.");
    lines.push("");
    appendArtifactReferenceSection(lines, config, "Approved plan artifact", proposalArtifact);
    appendArtifactReferenceSection(lines, config, "Latest execute artifact", implementationArtifact);
    appendArtifactReferenceSection(
      lines,
      config,
      "Latest verification artifact",
      resolveLatestGoalLoopVerificationArtifact(config, proposalArtifact, iteration)
    );
    return lines;
  }

  return lines;
}

function buildPromptText(config: RuntimeConfig, profile: Profile, task: TaskRecord): string {
  const payloadBlock = summarizeJson(task.payload);
  const phaseSkills = Array.isArray(task.payload.phase_skills)
    ? task.payload.phase_skills.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const effectiveSkills = [...new Set([...profile.skills, ...phaseSkills])];
  const declaredArtifactPaths = [...new Set(
    extractArtifactReferences(task)
      .filter((reference) => reference.role === "required_artifact" || reference.role.endsWith("_artifact"))
      .map((reference) => reference.relative_path)
  )];
  const taskSpecificRules =
    task.kind === "github-story"
      ? [
          "Task-specific output rules:",
          "- This is summary-only work. Do not create files for this task.",
          "- Report `artifact_paths` as an empty array unless you actually wrote a managed artifact under the runtime artifact directory.",
          "- Do not put repository source paths in `artifact_paths`; mention them in `file_changes` or `operator_summary` instead.",
          "- Report `file_changes` as an empty array unless this run actually edited files.",
          ""
        ]
      : task.kind === "discord-reply"
        ? [
            "Task-specific output rules:",
            "- This is reply-only work. Do not invent repository edits, changelog files, or managed artifacts for this task.",
            "- Draft the reply in `operator_summary` unless the task explicitly asks for another channel-specific format.",
            "- Report `artifact_paths` as an empty array unless you actually wrote a managed artifact under the runtime artifact directory.",
            "- Report `file_changes` as an empty array unless this run actually edited files.",
            ""
          ]
        : declaredArtifactPaths.length > 0
          ? [
              "Task-specific output rules:",
              "- This task declares managed artifacts. If you create or verify them on disk in this run, include their relative managed paths in `artifact_paths`.",
              `- Expected managed artifact paths for this task: ${declaredArtifactPaths.join(", ")}.`,
              "- Use runtime-managed relative paths like `campaigns/...` or `reports/...`, not absolute filesystem paths, in `artifact_paths`.",
              ""
            ]
          : [];
  const lines = [
    config.runtimePolicy,
    "",
    `Profile: ${profile.profile_id} (${profile.style})`,
    `Role: ${profile.role}`,
    "",
    "Profile directives:",
    ...profile.system_prompt_parts.map((line) => `- ${line}`),
    "",
    `Task kind: ${task.kind}`,
    `Task source: ${task.source}`,
    `Task priority: ${task.priority}`,
    `Task subject: ${task.subject ?? "unspecified"}`,
    `Task description: ${task.description ?? "none"}`,
    "",
    `Skills: ${effectiveSkills.join(", ") || "none"}`,
    "",
    ...(profile.style === "codex-like"
      ? [
          "Execution rules:",
          "- Start by using Codex tools and shell commands when the task requires filesystem inspection or changes.",
          "- Do not send an in_progress update or a JSON status blob before you have executed the required commands for this run.",
          "- Do not claim commands were run, files were read, or files were created unless you actually did so in this run.",
          "- If the task requires creating or modifying a file, verify it on disk with a follow-up read/list command before reporting completed.",
          "- Your final JSON status must be completed or blocked. Do not return in_progress.",
          "- If execution is blocked or you cannot verify the file on disk, return blocked instead of describing hypothetical success.",
          ""
        ]
      : profile.style === "claude-like"
        ? [
            "Execution rules:",
            "- Start by using Claude Code tools and shell commands when the task requires filesystem inspection or changes.",
            "- Treat this run as trusted-VM work: do not stop to ask for permissions if the adapter was launched in bypass mode.",
            "- Do not claim commands were run, files were read, or files were created unless you actually did so in this run.",
            "- If the task requires creating or modifying a file, verify it on disk with a follow-up read/list command before reporting completed.",
            "- Your final JSON status must be completed or blocked. Do not return in_progress.",
            ""
          ]
        : profile.style === "hermes-like"
          ? [
              "Execution rules:",
              "- Start by using Hermes terminal and file tools when the task requires filesystem inspection or changes.",
              "- Treat this run as trusted-VM work: do not stop for dangerous-command approvals if the adapter was launched with --yolo.",
              "- Do not claim commands were run, files were read, or files were created unless you actually did so in this run.",
              "- If the task requires creating or modifying a file, verify it on disk with a follow-up read/list command before reporting completed.",
              "- Your final JSON status must be completed or blocked. Do not return in_progress.",
              ""
            ]
          : []),
    ...taskSpecificRules,
    ...buildGoalLoopContextLines(config, task),
    "Task payload:",
    payloadBlock,
    "",
    "Respond in JSON with keys: status, operator_summary, machine_status, file_changes, artifact_paths, follow_up_tasks, external_messages."
  ];

  return lines.join("\n").slice(0, profile.context_policy.max_prompt_chars);
}

function normalizeExternalInputs(task: TaskRecord): Array<Record<string, unknown>> {
  const rawValue = task.payload.external_inputs;
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue.map((item, index) => {
    if (typeof item === "string") {
      return {
        index,
        source: item,
        cache_status: "uncached"
      };
    }

    if (!item || typeof item !== "object") {
      return {
        index,
        source: `external_input_${index}`,
        cache_status: "uncached"
      };
    }

    const entry = item as Record<string, unknown>;
    const cachedPath = readString(entry.cache_path);
    const cachedHash = readString(entry.cache_hash);
    const cachedContent = readString(entry.cached_content);
    const source =
      readString(entry.source) ??
      readString(entry.url) ??
      readString(entry.name) ??
      `external_input_${index}`;

    return {
      ...entry,
      index,
      source,
      cache_status: cachedPath || cachedHash || cachedContent ? "cached" : "uncached"
    };
  });
}

function hasUncachedExternalInput(externalInputs: Array<Record<string, unknown>>): boolean {
  return externalInputs.some((entry) => entry.cache_status !== "cached");
}

function extractArtifactReferences(task: TaskRecord): Array<{ role: string; relative_path: string }> {
  const references: Array<{ role: string; relative_path: string }> = [];
  const addRef = (role: string, value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const relativePath = sanitizeRelativeArtifactPath(value);
    if (!relativePath) {
      return;
    }
    references.push({ role, relative_path: relativePath });
  };

  addRef("proposal_artifact", task.payload.proposal_artifact);
  addRef("implementation_artifact", task.payload.implementation_artifact);
  addRef("verification_artifact", task.payload.verification_artifact);

  if (Array.isArray(task.payload.required_artifacts)) {
    for (const value of task.payload.required_artifacts) {
      addRef("required_artifact", value);
    }
  }

  if (Array.isArray(task.payload.artifact_paths)) {
    for (const value of task.payload.artifact_paths) {
      addRef("artifact_path", value);
    }
  }

  const deduped = new Map<string, { role: string; relative_path: string }>();
  for (const reference of references) {
    const key = `${reference.role}:${reference.relative_path}`;
    if (!deduped.has(key)) {
      deduped.set(key, reference);
    }
  }
  return [...deduped.values()];
}

async function sha256File(fullPath: string): Promise<string> {
  const content = await readFile(fullPath);
  return createHash("sha256").update(content).digest("hex");
}

function sha256String(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function collectArtifactSnapshot(
  config: RuntimeConfig,
  task: TaskRecord
): Promise<Array<Record<string, unknown>>> {
  const references = extractArtifactReferences(task);
  const snapshots: Array<Record<string, unknown>> = [];

  for (const reference of references) {
    const fullPath = path.join(config.artifactDir, reference.relative_path);
    if (!existsSync(fullPath)) {
      snapshots.push({
        role: reference.role,
        relative_path: reference.relative_path,
        exists: false,
        sha256: null
      });
      continue;
    }

    snapshots.push({
      role: reference.role,
      relative_path: reference.relative_path,
      exists: true,
      sha256: await sha256File(fullPath)
    });
  }

  return snapshots;
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    ok: result.exitCode === 0,
    stdout: Buffer.from(result.stdout).toString("utf8").trim(),
    stderr: Buffer.from(result.stderr).toString("utf8").trim()
  };
}

function detectWorkspace(
  adapterConfig: AdapterConfig
): { kind: string; root: string; repo_root?: string | null; git_sha?: string | null; dirty?: boolean | null } {
  const workspaceRoot =
    adapterConfig.mode === "agent-cli" && adapterConfig.workingDir
      ? path.resolve(adapterConfig.workingDir)
      : process.cwd();
  const repoRootResult = runGit(["rev-parse", "--show-toplevel"], workspaceRoot);
  if (!repoRootResult.ok || !repoRootResult.stdout) {
    return {
      kind: "no-repo",
      root: workspaceRoot,
      repo_root: null,
      git_sha: null,
      dirty: null
    };
  }

  const repoRoot = repoRootResult.stdout;
  const gitShaResult = runGit(["rev-parse", "HEAD"], workspaceRoot);
  const dirtyResult = runGit(["status", "--porcelain"], workspaceRoot);
  return {
    kind: "git",
    root: workspaceRoot,
    repo_root: repoRoot,
    git_sha: gitShaResult.ok ? gitShaResult.stdout : null,
    dirty: dirtyResult.ok ? dirtyResult.stdout.length > 0 : null
  };
}

function deriveReplayGrade(
  adapterConfig: AdapterConfig,
  workspace: { dirty?: boolean | null },
  externalInputs: Array<Record<string, unknown>>
): ReplayGrade {
  if (workspace.dirty || hasUncachedExternalInput(externalInputs)) {
    return "best_effort";
  }
  if (adapterConfig.mode === "agent-cli") {
    return "non_replayable_model";
  }
  return "inputs_frozen";
}

function nowIso(): string {
  return new Date().toISOString();
}

export function assembleContext(config: RuntimeConfig, profile: Profile, task: TaskRecord): string {
  return buildPromptText(config, profile, task);
}

type CompileBundleInput = {
  db: Database;
  config: RuntimeConfig;
  task: TaskRecord;
  attemptId: string;
  profile: Profile;
  adapterId: string;
  adapterConfig: AdapterConfig;
};

export async function compileBundle(input: CompileBundleInput): Promise<{
  bundleRecord: BundleArtifactRecord;
  bundleDocument: Record<string, unknown>;
  bundlePath: string;
  promptPath: string;
}> {
  const createdAt = nowIso();
  const bundleId = crypto.randomUUID();
  const promptText = buildPromptText(input.config, input.profile, input.task);
  const workflowId = typeof input.task.payload.workflow_id === "number" ? input.task.payload.workflow_id : null;
  const workflow = workflowId ? getWorkflowById(input.db, workflowId) : null;
  const artifacts = await collectArtifactSnapshot(input.config, input.task);
  const externalInputs = normalizeExternalInputs(input.task);
  const workspace = detectWorkspace(input.adapterConfig);
  const replayGrade = deriveReplayGrade(input.adapterConfig, workspace, externalInputs);
  const taskSnapshot = buildBundleTaskSnapshot(input.task);

  const lessonsBundle = input.task.lesson_topic
    ? loadLessonsForTopic(path.join(input.config.stateDir, "memory"), input.task.lesson_topic)
    : null;

  const datePrefix = createdAt.slice(0, 10);
  const relativePath = path.posix.join("bundles", datePrefix, `${bundleId}.json`);
  const promptRelativePath = path.posix.join("bundles", datePrefix, `${bundleId}.prompt.txt`);
  const bundlePath = path.join(input.config.artifactDir, relativePath);
  const promptPath = path.join(input.config.artifactDir, promptRelativePath);

  const bundleDocument: Record<string, unknown> = {
    bundle_version: "1",
    bundle_id: bundleId,
    task: taskSnapshot,
    workflow: workflow
      ? {
          id: workflow.id,
          template: workflow.template,
          instance_key: workflow.instance_key,
          current_state: workflow.current_state,
          context: workflow.context_json ? JSON.parse(workflow.context_json) : null
        }
      : null,
    agent: {
      agent_id: input.config.runtimeName,
      internal_name: input.config.runtimeName,
      external_name: null,
      onchain_identity: null
    },
    constitution: {
      soul: { status: "absent" },
      purpose: { status: "absent" }
    },
    profile: {
      profile_id: input.profile.profile_id,
      style: input.profile.style,
      role: input.profile.role,
      skills: input.profile.skills
    },
    adapter: {
      adapter_id: input.adapterId,
      mode: input.adapterConfig.mode,
      model: "model" in input.adapterConfig ? (input.adapterConfig.model ?? null) : null,
      timeout_ms: input.adapterConfig.timeoutMs,
      behavior_args:
        input.adapterConfig.mode === "agent-cli"
          ? {
              driver: input.adapterConfig.driver,
              sandbox: input.adapterConfig.sandbox ?? null,
              extra_args: input.adapterConfig.extraArgs ?? []
            }
          : input.adapterConfig.mode === "ollama-generate"
            ? {
              endpoint: input.adapterConfig.endpoint
            }
            : {
                command: input.adapterConfig.command,
                extra_args: input.adapterConfig.extraArgs ?? []
              }
    },
    workspace,
    artifacts,
    external_inputs: externalInputs,
    prompt: {
      rendered_text: promptText
    },
    lessons: lessonsBundle
      ? {
          family: input.task.lesson_topic,
          patterns: lessonsBundle.patterns,
          dead_ends: lessonsBundle.deadEnds
        }
      : null
  };

  const canonicalHashBasis = canonicalize({
    ...bundleDocument,
    bundle_id: "__bundle_hash_basis__"
  });
  if (typeof canonicalHashBasis !== "string") {
    throw new Error("Failed to canonicalize bundle hash basis");
  }
  const bundleHash = sha256String(canonicalHashBasis);

  const canonicalJson = canonicalize(bundleDocument);
  if (typeof canonicalJson !== "string") {
    throw new Error("Failed to canonicalize bundle document");
  }

  await mkdir(path.dirname(bundlePath), { recursive: true });
  await Bun.write(bundlePath, `${canonicalJson}\n`);
  await Bun.write(promptPath, promptText);

  return {
    bundleRecord: {
      bundle_id: bundleId,
      task_id: input.task.task_id,
      attempt_id: input.attemptId,
      bundle_hash: bundleHash,
      agent_id: input.config.runtimeName,
      profile_id: input.profile.profile_id,
      adapter_id: input.adapterId,
      model: "model" in input.adapterConfig ? (input.adapterConfig.model ?? null) : null,
      variant_id: null,
      evaluator_version: null,
      replay_grade: replayGrade,
      relative_path: relativePath,
      prompt_relative_path: promptRelativePath,
      created_at: createdAt
    },
    bundleDocument,
    bundlePath,
    promptPath
  };
}

export async function renderPromptFromPersistedBundle(
  config: RuntimeConfig,
  bundle: Pick<BundleArtifactRecord, "prompt_relative_path">
): Promise<string> {
  const promptPath = path.join(config.artifactDir, bundle.prompt_relative_path);
  return await Bun.file(promptPath).text();
}
