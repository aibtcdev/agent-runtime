import { existsSync } from "node:fs";
import path from "node:path";
import type { Profile, TaskRecord, RuntimeConfig } from "./types";

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

function appendArtifactSection(
  lines: string[],
  config: RuntimeConfig,
  title: string,
  artifactPath: string | null
): void {
  if (!artifactPath) {
    return;
  }

  lines.push(`${title}: ${sanitizeRelativeArtifactPath(artifactPath)}`);
  const summary = readArtifactSummary(config, artifactPath);
  if (summary) {
    lines.push(`- Status: ${summary}`);
  }
  lines.push("");
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

export function assembleContext(config: RuntimeConfig, profile: Profile, task: TaskRecord): string {
  const payloadBlock = summarizeJson(task.payload);
  const phaseSkills = Array.isArray(task.payload.phase_skills)
    ? task.payload.phase_skills.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const effectiveSkills = [...new Set([...profile.skills, ...phaseSkills])];
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
      : []),
    ...buildGoalLoopContextLines(config, task),
    "Task payload:",
    payloadBlock,
    "",
    "Respond in JSON with keys: status, operator_summary, machine_status, file_changes, artifact_paths, follow_up_tasks, external_messages."
  ];

  return lines.join("\n").slice(0, profile.context_policy.max_prompt_chars);
}
