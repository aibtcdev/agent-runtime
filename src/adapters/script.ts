import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AdapterExecutionResult, ExecutionRequest, ScriptAdapterConfig } from "../types";
import { buildAgentCliAuditDir } from "./cli";

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

function redactEnvValue(key: string, value: string): string {
  if (/token|secret|password|key|auth/i.test(key)) {
    return "[redacted]";
  }
  return value;
}

function taskArgs(request: ExecutionRequest): string[] {
  const args = request.task.payload.args;
  if (!Array.isArray(args)) {
    return [];
  }
  return args.filter((value): value is string => typeof value === "string");
}

function buildScriptEnv(request: ExecutionRequest, adapter: ScriptAdapterConfig): LoadedEnv {
  const envFileVars = adapter.envFile ? parseEnvFile(adapter.envFile) : {};
  return {
    ...envFileVars,
    ...(adapter.env ?? {}),
    AGENT_RUNTIME_NAME: request.runtimeConfig.runtimeName,
    AGENT_RUNTIME_TASK_ID: request.task.task_id,
    AGENT_RUNTIME_ATTEMPT_ID: request.attempt.attempt_id,
    AGENT_RUNTIME_ARTIFACT_DIR: request.runtimeConfig.artifactDir,
    AGENT_RUNTIME_STATE_DIR: request.runtimeConfig.stateDir,
    AGENT_RUNTIME_TASK_PAYLOAD_JSON: JSON.stringify(request.task.payload)
  };
}

function writeAuditFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function writeScriptAuditArtifacts(
  request: ExecutionRequest,
  invocation: { command: string; args: string[]; cwd: string; env: LoadedEnv },
  payload: {
    stdout: string;
    stderr: string;
    result?: AdapterExecutionResult;
    note?: string;
  }
): Record<string, string> {
  const auditDir = buildAgentCliAuditDir(
    request.runtimeConfig.artifactDir,
    request.task.task_id,
    request.attempt.attempt_id
  );
  mkdirSync(auditDir, { recursive: true });

  const invocationPath = path.join(auditDir, "invocation.json");
  const promptPath = path.join(auditDir, "assembled-context.txt");
  const stdoutPath = path.join(auditDir, "stdout.log");
  const stderrPath = path.join(auditDir, "stderr.log");
  const lastMessagePath = path.join(auditDir, "last-message.txt");
  const resultPath = path.join(auditDir, "result.json");
  const lastMessage = payload.stdout || payload.stderr;

  writeAuditFile(
    invocationPath,
    JSON.stringify(
      {
        task_id: request.task.task_id,
        attempt_id: request.attempt.attempt_id,
        bundle_id: request.bundle.bundle_id,
        adapter_id: request.adapterId,
        driver: "script",
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
  writeAuditFile(lastMessagePath, lastMessage);
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

export async function executeWithScript(request: ExecutionRequest): Promise<AdapterExecutionResult> {
  if (request.adapterConfig.mode !== "script") {
    throw new Error(`Invalid adapter mode for script execution: ${request.adapterConfig.mode}`);
  }
  const adapter = request.adapterConfig;
  const cwd = adapter.workingDir ? path.resolve(adapter.workingDir) : process.cwd();
  const env = buildScriptEnv(request, adapter);
  const args = [...(adapter.extraArgs ?? []), ...taskArgs(request)];

  return await new Promise<AdapterExecutionResult>((resolve) => {
    const child = spawn(adapter.command, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
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
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const auditPaths = writeScriptAuditArtifacts(request, { command: adapter.command, args, cwd, env }, {
        stdout,
        stderr,
        note: "timeout"
      });
      resolve({
        rawOutput: stderr || stdout || "script timed out",
        exitStatus: "timeout",
        retryClass: "retryable",
        diagnostics: {
          command: adapter.command,
          args,
          cwd,
          ...auditPaths
        }
      });
    }, adapter.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8") || error.message;
      const result: AdapterExecutionResult = {
        rawOutput: stderr,
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: {
          command: adapter.command,
          args,
          cwd,
          error: error.message
        }
      };
      const auditPaths = writeScriptAuditArtifacts(request, { command: adapter.command, args, cwd, env }, {
        stdout,
        stderr,
        result
      });
      resolve({
        ...result,
        diagnostics: {
          ...(result.diagnostics ?? {}),
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
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const result: AdapterExecutionResult = {
        rawOutput: stdout || stderr,
        exitStatus: code === 0 ? "ok" : "error",
        retryClass: code === 0 ? "none" : "retryable",
        diagnostics: {
          command: adapter.command,
          args,
          cwd,
          exit_code: code ?? 1,
          stdout,
          stderr
        }
      };
      const auditPaths = writeScriptAuditArtifacts(request, { command: adapter.command, args, cwd, env }, {
        stdout,
        stderr,
        result
      });
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

