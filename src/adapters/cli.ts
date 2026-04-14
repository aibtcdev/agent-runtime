import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { AgentCliAdapterConfig, AdapterExecutionResult, ExecutionRequest } from "../types";

type LoadedEnv = Record<string, string>;

function parseEnvFile(filePath: string): LoadedEnv {
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
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadAdapterEnv(adapter: AgentCliAdapterConfig): LoadedEnv {
  const envFileVars = adapter.envFile ? parseEnvFile(adapter.envFile) : {};
  return {
    ...envFileVars,
    ...(adapter.env ?? {})
  };
}

function resolveAdapterValue(
  explicitValue: string | undefined,
  env: LoadedEnv,
  envKey: string,
  fallback?: string
): string | undefined {
  return explicitValue ?? env[envKey] ?? fallback;
}

function buildCodexArgs(
  request: ExecutionRequest,
  adapter: AgentCliAdapterConfig,
  env: LoadedEnv,
  outputLastMessagePath: string
): string[] {
  const model = resolveAdapterValue(adapter.model, env, "CODEX_MODEL");
  const providerId = resolveAdapterValue(adapter.providerId, env, "CODEX_MODEL_PROVIDER_ID", "ollama_remote");
  const providerName = resolveAdapterValue(adapter.providerName, env, "CODEX_MODEL_PROVIDER_NAME", "Ollama Remote");
  const providerBaseUrl = resolveAdapterValue(adapter.providerBaseUrl, env, "CODEX_BASE_URL");
  const providerWireApi = adapter.providerWireApi ?? "responses";
  const requiresOpenAIAuth = adapter.providerRequiresOpenAIAuth ?? false;
  const sandbox = adapter.sandbox ?? "workspace-write";
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    sandbox,
    "--output-last-message",
    outputLastMessagePath
  ];

  if (adapter.workingDir) {
    args.push("--cd", adapter.workingDir);
  }
  if (model) {
    args.push("-c", `model=${JSON.stringify(model)}`);
  }
  if (providerId) {
    args.push("-c", `model_provider=${JSON.stringify(providerId)}`);
  }
  if (providerId && providerName && providerBaseUrl) {
    args.push(
      "-c",
      `model_providers.${providerId}={name=${JSON.stringify(providerName)},base_url=${JSON.stringify(providerBaseUrl)},wire_api=${JSON.stringify(providerWireApi)},requires_openai_auth=${requiresOpenAIAuth}}`
    );
  }
  if (Array.isArray(adapter.extraArgs)) {
    args.push(...adapter.extraArgs);
  }

  args.push("-");
  return args;
}

export function buildAgentCliInvocation(
  request: ExecutionRequest,
  adapter: AgentCliAdapterConfig,
  outputLastMessagePath: string
): { command: string; args: string[]; env: LoadedEnv; cwd: string } {
  const env = loadAdapterEnv(adapter);
  const cwd = adapter.workingDir ? path.resolve(adapter.workingDir) : process.cwd();
  const mergedAdapter = {
    ...adapter,
    workingDir: cwd
  };

  if (mergedAdapter.driver === "codex") {
    return {
      command: mergedAdapter.command,
      args: buildCodexArgs(request, mergedAdapter, env, outputLastMessagePath),
      env,
      cwd
    };
  }

  throw new Error(`Unsupported agent-cli driver: ${mergedAdapter.driver}`);
}

function redactEnvValue(key: string, value: string): string {
  if (/token|secret|password|key|auth/i.test(key)) {
    return "[redacted]";
  }
  return value;
}

function buildAuditDir(request: ExecutionRequest): string {
  return path.join(request.runtimeConfig.artifactDir, "adapter-runs", request.task.task_id);
}

function writeAuditFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function writeAuditArtifacts(
  request: ExecutionRequest,
  invocation: { command: string; args: string[]; env: LoadedEnv; cwd: string },
  payload: {
    stdout: string;
    stderr: string;
    lastMessage: string;
    result?: AdapterExecutionResult;
    note?: string;
  }
): Record<string, string> {
  const auditDir = buildAuditDir(request);
  mkdirSync(auditDir, { recursive: true });

  const invocationPath = path.join(auditDir, "invocation.json");
  const promptPath = path.join(auditDir, "assembled-context.txt");
  const stdoutPath = path.join(auditDir, "stdout.log");
  const stderrPath = path.join(auditDir, "stderr.log");
  const lastMessagePath = path.join(auditDir, "last-message.txt");
  const resultPath = path.join(auditDir, "result.json");

  writeAuditFile(
    invocationPath,
    JSON.stringify(
      {
        task_id: request.task.task_id,
        adapter_id: request.adapterId,
        driver: request.adapterConfig.mode === "agent-cli" ? request.adapterConfig.driver : "unknown",
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: Object.fromEntries(
          Object.entries(invocation.env).map(([key, value]) => [key, redactEnvValue(key, value)])
        ),
        note: payload.note ?? null
      },
      null,
      2
    )
  );
  writeAuditFile(promptPath, request.assembledContext);
  writeAuditFile(stdoutPath, payload.stdout);
  writeAuditFile(stderrPath, payload.stderr);
  writeAuditFile(lastMessagePath, payload.lastMessage);
  if (payload.result) {
    writeAuditFile(resultPath, JSON.stringify(payload.result, null, 2));
  }

  return {
    audit_dir: auditDir,
    invocation_path: invocationPath,
    prompt_path: promptPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    last_message_path: lastMessagePath,
    result_path: resultPath
  };
}

export async function executeWithAgentCli(request: ExecutionRequest): Promise<AdapterExecutionResult> {
  if (request.adapterConfig.mode !== "agent-cli") {
    throw new Error(`Invalid adapter mode for agent-cli execution: ${request.adapterConfig.mode}`);
  }
  const adapter = request.adapterConfig;

  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-runtime-cli-"));
  const outputLastMessagePath = path.join(tempDir, "last-message.txt");
  const invocation = buildAgentCliInvocation(request, adapter, outputLastMessagePath);
  const childEnv = {
    ...process.env,
    ...invocation.env
  };

  if (childEnv.CODEX_HOME) {
    mkdirSync(path.resolve(invocation.cwd, childEnv.CODEX_HOME), { recursive: true });
  }

  return await new Promise<AdapterExecutionResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const lastMessage = existsSync(outputLastMessagePath)
        ? readFileSync(outputLastMessagePath, "utf8")
        : "";
      const auditPaths = writeAuditArtifacts(request, invocation, {
        stdout: stdoutText,
        stderr: stderrText,
        lastMessage,
        note: "timeout"
      });
      rmSync(tempDir, { recursive: true, force: true });
      resolve({
        rawOutput: stderrText || stdoutText || "agent-cli timed out",
        exitStatus: "timeout",
        retryClass: "retryable",
        diagnostics: {
          driver: adapter.driver,
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          ...auditPaths
        }
      });
    }, adapter.timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.stdin.end(request.assembledContext);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const auditPaths = writeAuditArtifacts(request, invocation, {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        lastMessage: "",
        note: "spawn_error"
      });
      rmSync(tempDir, { recursive: true, force: true });
      resolve({
        rawOutput: error instanceof Error ? error.message : String(error),
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: {
          driver: adapter.driver,
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          ...auditPaths
        }
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const lastMessage = existsSync(outputLastMessagePath)
        ? readFileSync(outputLastMessagePath, "utf8")
        : "";
      const result: AdapterExecutionResult = {
        rawOutput: lastMessage || stderrText || stdoutText || "",
        exitStatus: code === 0 ? "ok" : "error",
        retryClass: code === 0 ? "none" : "retryable",
        diagnostics: {
          driver: adapter.driver,
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          exit_code: code ?? 1,
          stdout: stdoutText,
          stderr: stderrText,
          last_message: lastMessage
        }
      };
      const auditPaths = writeAuditArtifacts(request, invocation, {
        stdout: stdoutText,
        stderr: stderrText,
        lastMessage,
        result
      });
      rmSync(tempDir, { recursive: true, force: true });

      resolve({
        ...result,
        diagnostics: {
          ...(result.diagnostics ?? {}),
          ...auditPaths
        }
      });
    });
  });
}
