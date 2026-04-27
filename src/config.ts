import path from "node:path";
import { mkdirSync } from "node:fs";
import type { AgentCliAdapterConfig, RuntimeConfig } from "./types";

type RuntimeConfigFile = Partial<RuntimeConfig> & {
  extends?: string;
};

export function resolvePath(baseDir: string, target: string): string {
  if (path.isAbsolute(target)) {
    return target;
  }
  return path.resolve(baseDir, target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRuntimeConfig(parent: RuntimeConfigFile, child: RuntimeConfigFile): RuntimeConfigFile {
  return {
    ...parent,
    ...child,
    profiles: {
      ...(parent.profiles ?? {}),
      ...(child.profiles ?? {})
    },
    adapters: Object.fromEntries(
      new Map([
        ...Object.entries(parent.adapters ?? {}),
        ...Object.entries(child.adapters ?? {})
      ]).entries()
    ) as RuntimeConfig["adapters"]
  };
}

async function readConfigFile(configPath: string): Promise<RuntimeConfigFile> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`Config not found: ${configPath}. Copy config/runtime.example.json to config/runtime.json first.`);
  }
  return JSON.parse(await file.text()) as RuntimeConfigFile;
}

function normalizeConfigFile(baseDir: string, parsed: RuntimeConfigFile): RuntimeConfigFile {
  const normalized: RuntimeConfigFile = { ...parsed };

  if (typeof parsed.stateDir === "string") {
    normalized.stateDir = resolvePath(baseDir, parsed.stateDir);
  }
  if (typeof parsed.logDir === "string") {
    normalized.logDir = resolvePath(baseDir, parsed.logDir);
  }
  if (typeof parsed.artifactDir === "string") {
    normalized.artifactDir = resolvePath(baseDir, parsed.artifactDir);
  }
  if (typeof parsed.dbPath === "string") {
    normalized.dbPath = resolvePath(baseDir, parsed.dbPath);
  }
  if (typeof parsed.lockPath === "string") {
    normalized.lockPath = resolvePath(baseDir, parsed.lockPath);
  }
  if (isRecord(parsed.profiles)) {
    normalized.profiles = Object.fromEntries(
      Object.entries(parsed.profiles).map(([key, value]) => [key, typeof value === "string" ? resolvePath(baseDir, value) : value])
    );
  }
  if (isRecord(parsed.adapters)) {
    normalized.adapters = Object.fromEntries(
      Object.entries(parsed.adapters).map(([key, value]) => [key, normalizeAdapter(baseDir, value as RuntimeConfig["adapters"][string])])
    ) as RuntimeConfig["adapters"];
  }

  return normalized;
}

async function loadConfigFileTree(configPath: string, seen = new Set<string>()): Promise<RuntimeConfigFile> {
  const normalizedPath = path.resolve(configPath);
  if (seen.has(normalizedPath)) {
    throw new Error(`Config extends cycle detected at ${normalizedPath}`);
  }
  seen.add(normalizedPath);

  const parsed = await readConfigFile(normalizedPath);
  const baseDir = path.dirname(normalizedPath);
  const normalized = normalizeConfigFile(baseDir, parsed);
  if (typeof parsed.extends !== "string" || parsed.extends.trim().length === 0) {
    return normalized;
  }

  const parentPath = resolvePath(baseDir, parsed.extends);
  const parent = await loadConfigFileTree(parentPath, seen);
  const child: RuntimeConfigFile = { ...normalized };
  delete child.extends;
  return mergeRuntimeConfig(parent, child);
}

function normalizeAdapter(baseDir: string, adapter: RuntimeConfig["adapters"][string]): RuntimeConfig["adapters"][string] {
  if (adapter.mode !== "agent-cli") {
    return adapter;
  }
  const cliAdapter = adapter as AgentCliAdapterConfig;
  const command = cliAdapter.command.includes("/") ? resolvePath(baseDir, cliAdapter.command) : cliAdapter.command;
  return {
    ...cliAdapter,
    command,
    workingDir: cliAdapter.workingDir ? resolvePath(baseDir, cliAdapter.workingDir) : baseDir,
    envFile: cliAdapter.envFile ? resolvePath(baseDir, cliAdapter.envFile) : undefined,
    settingsFile: cliAdapter.settingsFile ? resolvePath(baseDir, cliAdapter.settingsFile) : undefined
  };
}

export async function loadConfig(configPathArg?: string): Promise<{ config: RuntimeConfig; configPath: string; baseDir: string }> {
  const configPath = path.resolve(process.cwd(), configPathArg ?? "config/runtime.json");
  const baseDir = path.dirname(configPath);
  const parsed = await loadConfigFileTree(configPath) as RuntimeConfig;

  if (!isRecord(parsed.profiles) || !isRecord(parsed.adapters)) {
    throw new Error(`Invalid runtime config: ${configPath}`);
  }

  const config = parsed as RuntimeConfig;

  mkdirSync(config.stateDir, { recursive: true });
  mkdirSync(config.logDir, { recursive: true });
  mkdirSync(config.artifactDir, { recursive: true });

  return { config, configPath, baseDir };
}
