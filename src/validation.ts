import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CanonicalOutcome, Profile, RuntimeConfig, TaskInput, TaskRecord } from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTaskInput(value: unknown): TaskInput | null {
  if (!isObject(value)) {
    return null;
  }
  if (typeof value.kind !== "string" || typeof value.source !== "string" || !isObject(value.payload)) {
    return null;
  }
  const normalized: TaskInput = {
    kind: value.kind,
    source: value.source,
    payload: value.payload
  };
  if (typeof value.priority === "number") {
    normalized.priority = value.priority;
  }
  if (typeof value.requested_profile === "string") {
    normalized.requested_profile = value.requested_profile;
  }
  if (typeof value.requested_adapter === "string") {
    normalized.requested_adapter = value.requested_adapter;
  }
  if (typeof value.max_attempts === "number") {
    normalized.max_attempts = value.max_attempts;
  }
  return normalized;
}

function normalizeExternalMessages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => isObject(item));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeFileChanges(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (isObject(item)) {
        if (typeof item.path === "string") {
          return item.path;
        }
        if (typeof item.file === "string") {
          return item.file;
        }
      }
      return null;
    })
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeFollowUpTasks(value: unknown): TaskInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeTaskInput(item))
    .filter((item): item is TaskInput => item !== null);
}

function extractJsonObject(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (trimmed.startsWith("```")) {
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }
  }
  return trimmed;
}

export function normalizeCanonicalOutcome(rawOutput: string): CanonicalOutcome {
  try {
    const parsed = JSON.parse(extractJsonObject(rawOutput)) as Record<string, unknown>;
    const operatorSummary =
      typeof parsed.operator_summary === "string" && parsed.operator_summary.trim().length > 0
        ? parsed.operator_summary
        : rawOutput.slice(0, 4000);
    const machineStatus: CanonicalOutcome["machine_status"] =
      parsed.machine_status === "needs_retry" || parsed.machine_status === "blocked" || parsed.machine_status === "failed"
        ? parsed.machine_status
        : "ok";
    const parsedStatus = typeof parsed.status === "string" ? parsed.status : "completed";
    const status = inferStatusFromContent(parsedStatus, operatorSummary, machineStatus, rawOutput);

    return {
      status,
      operator_summary: operatorSummary,
      machine_status: status === "blocked" ? "blocked" : machineStatus,
      file_changes: normalizeFileChanges(parsed.file_changes),
      artifact_paths: normalizeStringArray(parsed.artifact_paths),
      follow_up_tasks: normalizeFollowUpTasks(parsed.follow_up_tasks),
      external_messages: normalizeExternalMessages(parsed.external_messages),
      workflow_signal: typeof parsed.workflow_signal === "string" ? parsed.workflow_signal : undefined,
      raw_output: rawOutput
    };
  } catch {
    const blocked = looksLikeBlockedExecution(rawOutput);
    return {
      status: blocked ? "blocked" : "completed",
      operator_summary: rawOutput.slice(0, 4000),
      machine_status: blocked ? "blocked" : "ok",
      file_changes: [],
      artifact_paths: [],
      follow_up_tasks: [],
      external_messages: [],
      workflow_signal: undefined,
      raw_output: rawOutput
    };
  }
}

function declaredArtifactPaths(task: TaskRecord): string[] {
  const direct = [
    typeof task.payload.output_path === "string" ? task.payload.output_path : null,
    typeof task.payload.checklist_path === "string" ? task.payload.checklist_path : null,
    typeof task.payload.proposal_artifact === "string" ? task.payload.proposal_artifact : null,
    typeof task.payload.implementation_artifact === "string" ? task.payload.implementation_artifact : null,
    typeof task.payload.verification_artifact === "string" ? task.payload.verification_artifact : null
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const required = Array.isArray(task.payload.required_artifacts)
    ? task.payload.required_artifacts.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  return [...new Set([...direct, ...required])];
}

function sanitizeRelativeArtifactPath(value: string): string {
  return value
    .replace(/^\/+/, "")
    .replace(/^deploy\/[^/]+\/state\/artifacts\/+/, "")
    .replace(/^state\/artifacts\/+/, "")
    .replace(/\.\./g, "")
    .trim();
}

function resolveManagedArtifactPath(config: RuntimeConfig, artifactPath: string): { relativePath: string; fullPath: string } | null {
  const trimmed = artifactPath.trim();
  if (!trimmed) {
    return null;
  }

  const artifactRoot = path.resolve(config.artifactDir);
  if (path.isAbsolute(trimmed)) {
    const absolutePath = path.resolve(trimmed);
    if (!absolutePath.startsWith(`${artifactRoot}${path.sep}`) && absolutePath !== artifactRoot) {
      return null;
    }
    const relativePath = path.relative(artifactRoot, absolutePath).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("..")) {
      return null;
    }
    return {
      relativePath,
      fullPath: absolutePath
    };
  }

  const relativePath = sanitizeRelativeArtifactPath(artifactPath);
  if (!relativePath) {
    return null;
  }
  return {
    relativePath,
    fullPath: path.join(config.artifactDir, relativePath)
  };
}

function readArtifactText(config: RuntimeConfig, artifactPath: string): string | null {
  const resolved = resolveManagedArtifactPath(config, artifactPath);
  if (!resolved) {
    return null;
  }
  if (!existsSync(resolved.fullPath)) {
    return null;
  }
  return readFileSync(resolved.fullPath, "utf8");
}

function firstNonEmptyLine(value: string): string {
  for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().length > 0) {
      return line.trim();
    }
  }
  return "";
}

function detectPlanArtifactPollution(content: string): string[] {
  const sample = content.slice(0, 4000);
  const heading = firstNonEmptyLine(sample).toLowerCase();
  const issues: string[] = [];

  if (/^#\s*verify\b/.test(heading) || /^#\s*verification\b/.test(heading)) {
    issues.push(`heading indicates verification content (${firstNonEmptyLine(sample)})`);
  }
  if (/^#\s*execute\b/.test(heading)) {
    issues.push(`heading indicates execution content (${firstNonEmptyLine(sample)})`);
  }
  if (/- Kind:\s*goal-verify-/i.test(sample)) {
    issues.push("artifact metadata identifies a goal verification task");
  }
  if (/- Kind:\s*goal-execute\b/i.test(sample)) {
    issues.push("artifact metadata identifies a goal execute task");
  }
  if (/"phase"\s*:\s*"verify-plan"/i.test(sample) || /"phase"\s*:\s*"verify-execute"/i.test(sample)) {
    issues.push("artifact payload phase is verification, not plan");
  }
  if (/"phase"\s*:\s*"execute"/i.test(sample)) {
    issues.push("artifact payload phase is execute, not plan");
  }
  if (/\*\*status:\s*blocked\*\*/i.test(sample) || /permission elevation required/i.test(sample) || /grant elevated sandbox/i.test(sample)) {
    issues.push("artifact body contains blocker/escalation narrative instead of a clean plan");
  }

  return issues;
}

function detectExecuteArtifactPollution(content: string): string[] {
  const sample = content.slice(0, 4000);
  const heading = firstNonEmptyLine(sample).toLowerCase();
  const issues: string[] = [];

  if (/^#\s*verify\b/.test(heading) || /^#\s*verification\b/.test(heading)) {
    issues.push(`heading indicates verification content (${firstNonEmptyLine(sample)})`);
  }
  if (/- Kind:\s*goal-verify-/i.test(sample) || /"kind"\s*:\s*"goal-verify-/i.test(sample)) {
    issues.push("artifact metadata identifies a goal verification task");
  }
  if (/"phase"\s*:\s*"verify-plan"/i.test(sample) || /"phase"\s*:\s*"verify-execute"/i.test(sample)) {
    issues.push("artifact payload phase is verification, not execute");
  }

  return issues;
}

function looksLikePromptEcho(value: string): boolean {
  const sample = value.trim();
  if (!sample) {
    return false;
  }
  return sample.includes("Respond in JSON with keys:")
    || sample.includes("\"task\":\"explain_changes\"")
    || sample.includes("Task kind:")
    || sample.includes("Task payload:");
}

const blockedLanguagePatterns = [
  "bwrap: loopback: failed rtm_newaddr: operation not permitted",
  "sandbox blocked",
  "sandbox restriction",
  "sandbox restrictions",
  "sandbox blocked all shell commands",
  "sandbox blocked all shell commands and file operations",
  "blocked by sandbox",
  "unable to read the approved plan",
  "grant elevated sandbox",
  "elevate sandbox permissions",
  "permission escalation required",
  "permission elevation required",
  "provide repository contents directly",
  "permission elevation to proceed",
  "all shell attempts are blocked",
  "cannot complete the execution verification loop",
  "without sandbox access",
  "cannot verify the actual runtime behavior",
  "blocked_pending_operator_action",
  "environment prevented execution",
  "environmental blocker"
];

function looksLikeBlockedExecution(value: string): boolean {
  const sample = value.trim().toLowerCase();
  if (!sample) {
    return false;
  }
  return blockedLanguagePatterns.some((pattern) => sample.includes(pattern));
}

function inferStatusFromContent(
  parsedStatus: string,
  operatorSummary: string,
  machineStatus: CanonicalOutcome["machine_status"],
  rawOutput: string
): CanonicalOutcome["status"] {
  if (
    parsedStatus === "completed"
    && (machineStatus === "blocked" || looksLikeBlockedExecution(operatorSummary) || looksLikeBlockedExecution(rawOutput))
  ) {
    return "blocked";
  }
  return parsedStatus === "completed"
    || parsedStatus === "retryable_failure"
    || parsedStatus === "permanent_failure"
    || parsedStatus === "blocked"
    ? parsedStatus
    : "completed";
}

function extractClaimedPath(entry: string): string | null {
  const trimmed = entry.trim();
  const withoutPrefix = trimmed.replace(/^(created|modified|updated|deleted):\s*/i, "");
  const pathBeforeSummary = withoutPrefix.split(/\s+-\s+/, 1)[0] ?? withoutPrefix;
  const candidate = pathBeforeSummary.trim();
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return null;
  }
  return candidate;
}

async function claimedPathExists(config: RuntimeConfig, claimedPath: string): Promise<boolean> {
  const normalized = claimedPath.trim();
  if (!normalized) {
    return true;
  }
  const managed = resolveManagedArtifactPath(config, normalized);
  if (managed) {
    return await Bun.file(managed.fullPath).exists();
  }
  const repoCandidate = path.resolve(normalized);
  return await Bun.file(repoCandidate).exists();
}

async function hasOutOfRootArtifactDuplicate(config: RuntimeConfig, artifactPath: string): Promise<boolean> {
  const resolved = resolveManagedArtifactPath(config, artifactPath);
  if (!resolved) {
    return false;
  }

  const repoCandidate = path.resolve(resolved.relativePath);
  if (repoCandidate === resolved.fullPath) {
    return false;
  }

  return await Bun.file(repoCandidate).exists();
}

export async function verifyTaskInputArtifacts(
  config: RuntimeConfig,
  task: TaskRecord
): Promise<string[]> {
  const issues: string[] = [];
  const phase = typeof task.payload.phase === "string" ? task.payload.phase : "";
  const proposalArtifact = typeof task.payload.proposal_artifact === "string" ? task.payload.proposal_artifact : null;
  const implementationArtifact =
    typeof task.payload.implementation_artifact === "string" ? task.payload.implementation_artifact : null;

  if ((phase === "execute" || phase === "verify") && proposalArtifact) {
    const content = readArtifactText(config, proposalArtifact);
    if (content === null) {
      issues.push(`proposal artifact missing from disk: ${proposalArtifact}`);
    } else {
      const pollution = detectPlanArtifactPollution(content);
      if (pollution.length > 0) {
        issues.push(`proposal artifact polluted (${sanitizeRelativeArtifactPath(proposalArtifact)}): ${pollution.join("; ")}`);
      }
    }
  }

  if (phase === "verify" && implementationArtifact) {
    const content = readArtifactText(config, implementationArtifact);
    if (content === null) {
      issues.push(`implementation artifact missing from disk: ${implementationArtifact}`);
    } else {
      const pollution = detectExecuteArtifactPollution(content);
      if (pollution.length > 0) {
        issues.push(`implementation artifact polluted (${sanitizeRelativeArtifactPath(implementationArtifact)}): ${pollution.join("; ")}`);
      }
    }
  }

  return issues;
}

export async function verifyCompletedTaskOutcome(
  config: RuntimeConfig,
  task: TaskRecord,
  outcome: CanonicalOutcome
): Promise<string[]> {
  const issues: string[] = [];

  if (outcome.status !== "completed") {
    return issues;
  }

  if (looksLikePromptEcho(outcome.operator_summary) || looksLikePromptEcho(outcome.raw_output ?? "")) {
    issues.push("model returned prompt/context echo instead of a task result");
  }
  if (outcome.machine_status !== "ok") {
    issues.push(`completed outcome reported non-ok machine_status: ${outcome.machine_status}`);
  }
  if (looksLikeBlockedExecution(outcome.operator_summary) || looksLikeBlockedExecution(outcome.raw_output ?? "")) {
    issues.push("completed outcome text indicates execution was blocked");
  }

  const requiredArtifacts = declaredArtifactPaths(task);
  if (requiredArtifacts.length > 0) {
    for (const artifactPath of requiredArtifacts) {
      const resolved = resolveManagedArtifactPath(config, artifactPath);
      const exists = resolved ? await Bun.file(resolved.fullPath).exists() : false;
      if (!exists) {
        issues.push(`declared artifact missing: ${artifactPath}`);
        continue;
      }
      if (await hasOutOfRootArtifactDuplicate(config, artifactPath)) {
        issues.push(`declared artifact also exists outside managed artifact root: ${artifactPath}`);
      }
    }
  }

  if (requiredArtifacts.length > 0 && (!outcome.artifact_paths || outcome.artifact_paths.length === 0)) {
    issues.push("task declared artifacts but outcome recorded no artifact paths");
  }

  for (const artifactPath of outcome.artifact_paths ?? []) {
    const resolved = resolveManagedArtifactPath(config, artifactPath);
    const exists = resolved ? await Bun.file(resolved.fullPath).exists() : false;
    if (!exists) {
      issues.push(`outcome artifact path is not a managed on-disk artifact: ${artifactPath}`);
    }
  }

  for (const fileChange of outcome.file_changes ?? []) {
    const claimedPath = extractClaimedPath(fileChange);
    if (!claimedPath) {
      continue;
    }
    const exists = await claimedPathExists(config, claimedPath);
    if (!exists) {
      issues.push(`claimed file change missing from filesystem: ${claimedPath}`);
    }
  }

  return issues;
}

export async function validateRuntimeConfig(config: RuntimeConfig): Promise<string[]> {
  const issues: string[] = [];

  if (!config.runtimeName.trim()) {
    issues.push("runtimeName is required");
  }
  if (!config.runtimePolicy.trim()) {
    issues.push("runtimePolicy is required");
  }
  if (config.maxAttempts < 1) {
    issues.push("maxAttempts must be at least 1");
  }
  if (config.retryBackoffSeconds < 1) {
    issues.push("retryBackoffSeconds must be at least 1");
  }

  for (const [profileId, profilePath] of Object.entries(config.profiles)) {
    const file = Bun.file(profilePath);
    if (!(await file.exists())) {
      issues.push(`profile file missing for ${profileId}: ${profilePath}`);
    }
  }

  for (const [adapterId, adapter] of Object.entries(config.adapters)) {
    if (adapter.mode === "ollama-generate") {
      if (!adapter.endpoint.trim()) {
        issues.push(`adapter endpoint missing for ${adapterId}`);
      }
      if (!adapter.model.trim()) {
        issues.push(`adapter model missing for ${adapterId}`);
      }
      if (adapter.timeoutMs < 1000) {
        issues.push(`adapter timeout too low for ${adapterId}`);
      }
      continue;
    }

    if (adapter.mode === "agent-cli") {
      if (!adapter.command.trim()) {
        issues.push(`adapter command missing for ${adapterId}`);
      }
      if (adapter.timeoutMs < 1000) {
        issues.push(`adapter timeout too low for ${adapterId}`);
      }
      if (adapter.driver === "codex" && !(adapter.model || adapter.env?.CODEX_MODEL)) {
        issues.push(`codex adapter model missing for ${adapterId}`);
      }
      continue;
    }

    issues.push(`unsupported adapter mode for ${adapterId}`);
  }

  return issues;
}

export function validateProfile(profile: Profile): string[] {
  const issues: string[] = [];
  if (!profile.profile_id.trim()) {
    issues.push("profile_id is required");
  }
  if (!profile.role.trim()) {
    issues.push(`profile ${profile.profile_id || "<unknown>"} is missing role`);
  }
  if (profile.system_prompt_parts.length === 0) {
    issues.push(`profile ${profile.profile_id || "<unknown>"} has no system_prompt_parts`);
  }
  if (!profile.default_adapter.trim()) {
    issues.push(`profile ${profile.profile_id || "<unknown>"} is missing default_adapter`);
  }
  return issues;
}
