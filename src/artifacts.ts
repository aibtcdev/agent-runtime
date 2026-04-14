import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { CanonicalOutcome, RuntimeConfig, TaskRecord } from "./types";

function sanitizeRelativePath(target: string): string {
  return target
    .replace(/^\/+/, "")
    .replace(/^state\/artifacts\/+/, "")
    .replace(/\.\./g, "")
    .trim();
}

function readArtifactPath(task: TaskRecord): string | null {
  const outputPath = typeof task.payload.output_path === "string" ? task.payload.output_path : null;
  const checklistPath = typeof task.payload.checklist_path === "string" ? task.payload.checklist_path : null;
  return sanitizeRelativePath(outputPath ?? checklistPath ?? "");
}

function readPrimaryArtifactPaths(task: TaskRecord): string[] {
  const contentArtifact = readArtifactPath(task);
  if (contentArtifact) {
    return [contentArtifact];
  }

  const proposalArtifact =
    typeof task.payload.proposal_artifact === "string" ? sanitizeRelativePath(task.payload.proposal_artifact) : null;
  const implementationArtifact =
    typeof task.payload.implementation_artifact === "string"
      ? sanitizeRelativePath(task.payload.implementation_artifact)
      : null;
  const verificationArtifact =
    typeof task.payload.verification_artifact === "string"
      ? sanitizeRelativePath(task.payload.verification_artifact)
      : null;

  if (task.kind === "goal-plan" && proposalArtifact) {
    return [proposalArtifact];
  }
  if (task.kind === "goal-execute" && implementationArtifact) {
    return [implementationArtifact];
  }
  if ((task.kind === "goal-verify-plan" || task.kind === "goal-verify-execute" || task.kind === "goal-verify") && verificationArtifact) {
    return [verificationArtifact];
  }

  return [proposalArtifact, implementationArtifact, verificationArtifact].filter((value): value is string => Boolean(value));
}

function readDeclaredArtifactPaths(task: TaskRecord): string[] {
  const directPaths = [
    readArtifactPath(task),
    typeof task.payload.proposal_artifact === "string" ? sanitizeRelativePath(task.payload.proposal_artifact) : null,
    typeof task.payload.implementation_artifact === "string" ? sanitizeRelativePath(task.payload.implementation_artifact) : null,
    typeof task.payload.verification_artifact === "string" ? sanitizeRelativePath(task.payload.verification_artifact) : null
  ].filter((value): value is string => Boolean(value));

  const requiredArtifacts = Array.isArray(task.payload.required_artifacts)
    ? task.payload.required_artifacts
      .filter((value): value is string => typeof value === "string")
      .map((value) => sanitizeRelativePath(value))
      .filter((value) => value.length > 0)
    : [];

  return [...new Set([...directPaths, ...requiredArtifacts])];
}

export function getDeclaredArtifactPaths(task: TaskRecord): string[] {
  return readDeclaredArtifactPaths(task);
}

function shouldWriteArtifact(task: TaskRecord, outcome: CanonicalOutcome): boolean {
  if (outcome.status !== "completed") {
    return false;
  }
  if (readPrimaryArtifactPaths(task).length > 0) {
    return true;
  }
  const artifactPath = readArtifactPath(task);
  if (!artifactPath) {
    return false;
  }
  return [
    "community-research",
    "community-wiki-outline",
    "wallet-onboarding-research",
    "wallet-registration-research",
    "wallet-checklist-draft",
    "wallet-setup-guide",
    "community-wiki-review"
  ].includes(task.kind);
}

export async function writeArtifactIfNeeded(
  config: RuntimeConfig,
  task: TaskRecord,
  outcome: CanonicalOutcome
): Promise<string[]> {
  if (!shouldWriteArtifact(task, outcome)) {
    return [];
  }

  const relativePaths = readPrimaryArtifactPaths(task);
  if (relativePaths.length === 0) {
    return [];
  }

  const content = [
    `# ${task.subject ?? task.kind}`,
    "",
    `- Task ID: ${task.task_id}`,
    `- Kind: ${task.kind}`,
    `- Source: ${task.source}`,
    `- Updated: ${task.updated_at}`,
    "",
    "## Summary",
    "",
    outcome.operator_summary || "No summary returned.",
    "",
    "## Payload",
    "",
    "```json",
    JSON.stringify(task.payload, null, 2),
    "```",
    "",
    "## Raw Output",
    "",
    "```json",
    outcome.raw_output || "",
    "```",
    ""
  ].join("\n");

  const writtenPaths: string[] = [];
  for (const relativePath of relativePaths) {
    const fullPath = path.join(config.artifactDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await Bun.write(fullPath, content);
    writtenPaths.push(fullPath);
  }
  return writtenPaths;
}
