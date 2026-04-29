import { existsSync, readFileSync } from "node:fs";

export type LoadedEnv = Record<string, string>;

export function parseEnvFile(filePath: string): LoadedEnv {
  if (!existsSync(filePath)) {
    return {};
  }

  const result: LoadedEnv = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const rawKey = trimmed.slice(0, separator).trim();
    const key = rawKey.replace(/^export\s+/, "").trim();
    if (!key) {
      continue;
    }
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
