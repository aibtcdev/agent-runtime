import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { RuntimeConfig } from "./types";

export async function appendLog(config: RuntimeConfig, event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  const logPath = path.join(config.logDir, "runtime.jsonl");
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, line, "utf8");
}
