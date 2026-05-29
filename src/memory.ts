// Per-agent lessons layer per RFC 0009. Loads pattern files and dead-end entries for bundle injection.
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

export const PATTERNS_LINE_CAP = 150;

export type DeadEndEntry = {
  ts: string;
  family: string;
  agent?: string;
  topic: string;
  approach: string;
  outcome?: string;
  why_failed: string;
  next_try?: string;
  superseded_by?: string;
};

export type LessonsBundle = {
  patterns: string | null;
  deadEnds: DeadEndEntry[];
};

export function ensureMemoryLayout(memoryDir: string): void {
  mkdirSync(path.join(memoryDir, "patterns"), { recursive: true });
  const deadEndsPath = path.join(memoryDir, "dead-ends.jsonl");
  if (!existsSync(deadEndsPath)) {
    appendFileSync(deadEndsPath, "");
  }
  const recentLogPath = path.join(memoryDir, "recent.log");
  if (!existsSync(recentLogPath)) {
    appendFileSync(recentLogPath, "");
  }
}

export function appendRecentLog(
  memoryDir: string,
  entry: {
    ts: string;
    taskId: string;
    status: string;
    subject: string | null;
    operatorSummary: string;
    lessonTopic: string | null;
  }
): void {
  const line = [
    entry.ts,
    `task:${entry.taskId}`,
    entry.status,
    entry.lessonTopic ?? "general",
    JSON.stringify(entry.subject ?? ""),
    JSON.stringify(entry.operatorSummary)
  ].join(" | ");
  appendFileSync(path.join(memoryDir, "recent.log"), line + "\n");
}

export function appendDeadEnd(memoryDir: string, entry: DeadEndEntry): void {
  appendFileSync(path.join(memoryDir, "dead-ends.jsonl"), JSON.stringify(entry) + "\n");
}

export function checkPatternsCap(
  memoryDir: string,
  family: string
): { overCap: boolean; lineCount: number } {
  const filePath = path.join(memoryDir, "patterns", `${family}.md`);
  if (!existsSync(filePath)) {
    return { overCap: false, lineCount: 0 };
  }
  const lineCount = readFileSync(filePath, "utf8").split("\n").length;
  return { overCap: lineCount > PATTERNS_LINE_CAP, lineCount };
}

export function loadLessonsForTopic(memoryDir: string, family: string): LessonsBundle {
  const patternsPath = path.join(memoryDir, "patterns", `${family}.md`);
  const patterns = existsSync(patternsPath) ? readFileSync(patternsPath, "utf8") : null;

  const deadEndsPath = path.join(memoryDir, "dead-ends.jsonl");
  const deadEnds: DeadEndEntry[] = [];
  if (existsSync(deadEndsPath)) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    for (const line of readFileSync(deadEndsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as DeadEndEntry;
        if (entry.superseded_by) continue;
        if (entry.family !== family) continue;
        if (entry.ts >= sevenDaysAgo) deadEnds.push(entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  return { patterns, deadEnds };
}
