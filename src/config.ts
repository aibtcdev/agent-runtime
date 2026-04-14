import path from "node:path";
import { mkdirSync } from "node:fs";
import type { AgentCliAdapterConfig, RuntimeConfig } from "./types";

export function resolvePath(baseDir: string, target: string): string {
  if (path.isAbsolute(target)) {
    return target;
  }
  return path.resolve(baseDir, target);
}

export async function loadConfig(configPathArg?: string): Promise<{ config: RuntimeConfig; configPath: string; baseDir: string }> {
  const configPath = path.resolve(process.cwd(), configPathArg ?? "config/runtime.json");
  const baseDir = process.cwd();
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    throw new Error(`Config not found: ${configPath}. Copy config/runtime.example.json to config/runtime.json first.`);
  }

  const parsed = JSON.parse(await file.text()) as RuntimeConfig;
  const config: RuntimeConfig = {
    ...parsed,
    stateDir: resolvePath(baseDir, parsed.stateDir),
    logDir: resolvePath(baseDir, parsed.logDir),
    artifactDir: resolvePath(baseDir, parsed.artifactDir),
    dbPath: resolvePath(baseDir, parsed.dbPath),
    lockPath: resolvePath(baseDir, parsed.lockPath),
    profiles: Object.fromEntries(
      Object.entries(parsed.profiles).map(([key, value]) => [key, resolvePath(baseDir, value)])
    ),
    adapters: Object.fromEntries(
      Object.entries(parsed.adapters).map(([key, value]) => {
        if (value.mode !== "agent-cli") {
          return [key, value];
        }
        const adapter = value as AgentCliAdapterConfig;
        return [key, {
          ...adapter,
          workingDir: adapter.workingDir ? resolvePath(baseDir, adapter.workingDir) : baseDir,
          envFile: adapter.envFile ? resolvePath(baseDir, adapter.envFile) : undefined
        }];
      })
    )
  };

  mkdirSync(config.stateDir, { recursive: true });
  mkdirSync(config.logDir, { recursive: true });
  mkdirSync(config.artifactDir, { recursive: true });

  return { config, configPath, baseDir };
}
