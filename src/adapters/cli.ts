import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { AgentCliAdapterConfig, AdapterExecutionResult, ExecutionRequest } from "../types";
import { parseEnvFile, type LoadedEnv } from "../envfile";
import { resolveCredentialRefs } from "../credentials";

type AgentCliInvocation = {
  command: string;
  args: string[];
  env: LoadedEnv;
  cwd: string;
  inputText?: string;
};

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

function getAutonomyProfile(adapter: AgentCliAdapterConfig): "restricted" | "trusted-vm" {
  return adapter.autonomy ?? "restricted";
}

export function getDriverRequiredArgs(adapter: AgentCliAdapterConfig): string[] {
  if (getAutonomyProfile(adapter) !== "trusted-vm") {
    return [];
  }

  if (adapter.driver === "codex") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  if (adapter.driver === "claude-code") {
    return [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions"
    ];
  }

  if (adapter.driver === "hermes-agent") {
    return ["--yolo"];
  }

  return [];
}

function mergeArgs(requiredArgs: string[], extraArgs: string[] | undefined): string[] {
  return [...requiredArgs, ...(Array.isArray(extraArgs) ? extraArgs : [])];
}

function buildCodexArgs(
  request: ExecutionRequest,
  adapter: AgentCliAdapterConfig,
  env: LoadedEnv,
  outputLastMessagePath: string
): string[] {
  const model = resolveAdapterValue(adapter.model, env, "CODEX_MODEL");
  const providerId = resolveAdapterValue(adapter.providerId, env, "CODEX_MODEL_PROVIDER_ID");
  const providerName = resolveAdapterValue(adapter.providerName, env, "CODEX_MODEL_PROVIDER_NAME");
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

  args.push(...mergeArgs(getDriverRequiredArgs(adapter), adapter.extraArgs));
  args.push("-");
  return args;
}

function buildClaudeArgs(request: ExecutionRequest, adapter: AgentCliAdapterConfig): string[] {
  const args = ["-p", "--output-format", "json"];

  if (adapter.model) {
    args.push("--model", adapter.model);
  }
  if (adapter.settingsFile) {
    args.push("--settings", adapter.settingsFile);
  }

  // Profiles that declare no aibtc integration (e.g. council-lens-review, a
  // read-only reasoning profile) must not load the user-level ~/.claude.json
  // MCP servers. In `-p` mode the claude-code CLI spawns any configured stdio
  // MCP server (e.g. `aibtc`) and then blocks on teardown waiting for it to
  // exit — the process sits idle until the adapter timeout fires.
  // `--strict-mcp-config` loads only `--mcp-config` sources (none here), so no
  // MCP server starts and the process exits cleanly. The timeout path below is
  // the backstop for hangs from any other cause.
  if (request.profile?.integration_policies?.aibtc === "none") {
    args.push("--strict-mcp-config");
  }

  args.push(...mergeArgs(getDriverRequiredArgs(adapter), adapter.extraArgs));
  args.push(request.assembledContext);
  return args;
}

function buildHermesArgs(request: ExecutionRequest, adapter: AgentCliAdapterConfig): string[] {
  const args = ["chat", "-Q"];

  if (adapter.model) {
    args.push("--model", adapter.model);
  }

  args.push(...mergeArgs(getDriverRequiredArgs(adapter), adapter.extraArgs));
  args.push("-q", request.assembledContext);
  return args;
}

export function extractHermesResponseText(stdoutText: string): string {
  const lines = stdoutText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("session_id:"));
  const joined = lines.join("\n").trim();
  const jsonStart = joined.indexOf("{");
  const jsonEnd = joined.lastIndexOf("}");

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    return joined.slice(jsonStart, jsonEnd + 1);
  }

  return joined;
}

export function buildAgentCliInvocation(
  request: ExecutionRequest,
  adapter: AgentCliAdapterConfig,
  outputLastMessagePath: string
): AgentCliInvocation {
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
      cwd,
      inputText: request.assembledContext
    };
  }

  if (mergedAdapter.driver === "claude-code") {
    return {
      command: mergedAdapter.command,
      args: buildClaudeArgs(request, mergedAdapter),
      env,
      cwd
    };
  }

  if (mergedAdapter.driver === "hermes-agent") {
    return {
      command: mergedAdapter.command,
      args: buildHermesArgs(request, mergedAdapter),
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

export function buildAgentCliAuditDir(artifactDir: string, taskId: string, attemptId: string): string {
  return path.join(artifactDir, "adapter-runs", taskId, attemptId);
}

function writeAuditFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function writeAuditArtifacts(
  request: ExecutionRequest,
  invocation: AgentCliInvocation,
  payload: {
    stdout: string;
    stderr: string;
    lastMessage: string;
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

  writeAuditFile(
    invocationPath,
    JSON.stringify(
      {
        task_id: request.task.task_id,
        attempt_id: request.attempt.attempt_id,
        bundle_id: request.bundle.bundle_id,
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

function readLastMessage(
  adapter: AgentCliAdapterConfig,
  outputLastMessagePath: string,
  stdoutText: string,
  stderrText: string
): string {
  if (adapter.driver === "codex" && existsSync(outputLastMessagePath)) {
    return readFileSync(outputLastMessagePath, "utf8");
  }
  if (adapter.driver === "hermes-agent") {
    return extractHermesResponseText(stdoutText) || stderrText;
  }
  if (adapter.driver === "claude-code") {
    return extractClaudeCodeResultText(stdoutText) || stderrText;
  }
  return stdoutText || stderrText;
}

export function extractClaudeCodeResultText(stdoutText: string): string {
  // Claude Code with --output-format json wraps the model response in
  // {type:"result", subtype:"success", result:"<actual JSON>", ...}.
  // Unwrap so downstream canonical-outcome parsing sees the model's JSON.
  const trimmed = stdoutText.trim();
  if (!trimmed) {
    return stdoutText;
  }
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; result?: unknown };
    if (parsed && parsed.type === "result" && typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch {
    /* not a Claude Code JSON envelope; fall through */
  }
  return stdoutText;
}

/**
 * Signal the child's entire process group, not just the direct child.
 *
 * CLI drivers (notably claude-code) spawn descendants — e.g. stdio MCP servers —
 * that ignore a SIGTERM aimed only at the parent and keep its stdio pipes open.
 * Because the run-once dispatcher reads those pipes, an un-reaped descendant
 * keeps the parent process alive, which leaves the systemd oneshot service stuck
 * in `activating` forever and freezes ALL dispatch for that agent. The child is
 * spawned with `detached: true`, so it leads its own process group and a negative
 * PID reaches the whole tree.
 */
function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group gone, or not a group leader — fall back to the direct child.
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

export async function executeWithAgentCli(request: ExecutionRequest): Promise<AdapterExecutionResult> {
  if (request.adapterConfig.mode !== "agent-cli") {
    throw new Error(`Invalid adapter mode for agent-cli execution: ${request.adapterConfig.mode}`);
  }
  const adapter = request.adapterConfig;

  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-runtime-cli-"));
  const outputLastMessagePath = path.join(tempDir, "last-message.txt");
  const invocation = buildAgentCliInvocation(request, adapter, outputLastMessagePath);
  const resolvedInvocationEnv = await resolveCredentialRefs(invocation.env);
  const childEnv = {
    ...process.env,
    ...resolvedInvocationEnv
  };

  if (childEnv.CODEX_HOME) {
    mkdirSync(path.resolve(invocation.cwd, childEnv.CODEX_HOME), { recursive: true });
  }

  return await new Promise<AdapterExecutionResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so the timeout path can signal the whole tree
      // (the CLI's MCP/tool subprocesses), not just the direct child.
      detached: true
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      // Terminate the whole process group, then escalate to SIGKILL if it
      // ignores SIGTERM, and detach the stdio pipes so a surviving descendant
      // can never hold this dispatcher process (and thus the systemd oneshot
      // service) open. Without this a hung child wedges all dispatch for the agent.
      killProcessTree(child, "SIGTERM");
      const sigkillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 5000);
      sigkillTimer.unref?.();
      try {
        child.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const lastMessage = readLastMessage(adapter, outputLastMessagePath, stdoutText, stderrText);
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
    child.stdin.end(invocation.inputText ?? "");

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
      const lastMessage = readLastMessage(adapter, outputLastMessagePath, stdoutText, stderrText);
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
