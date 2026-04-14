import { existsSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import type { ExecutionRequest, AdapterExecutionResult } from "../types";
import { executeWithOllama } from "./ollama";
import { executeWithAgentCli } from "./cli";

type AdapterHealth = {
  adapterId: string;
  ok: boolean;
  detail: Record<string, unknown>;
};

export async function healthcheckAdapter(adapterId: string, config: RuntimeConfig): Promise<AdapterHealth> {
  const adapter = config.adapters[adapterId];
  if (!adapter) {
    return { adapterId, ok: false, detail: { error: "adapter_not_found" } };
  }

  if (adapter.mode === "ollama-generate") {
    try {
      const response = await fetch(`${adapter.endpoint}/api/tags`, {
        headers: { "content-type": "application/json" }
      });
      const body = await response.json() as { models?: Array<{ name?: string }> };
      const availableModels = (body.models ?? []).map((model) => String(model.name ?? ""));
      return {
        adapterId,
        ok: response.ok && availableModels.includes(adapter.model),
        detail: {
          endpoint: adapter.endpoint,
          model: adapter.model,
          available_models: availableModels
        }
      };
    } catch (error) {
      return {
        adapterId,
        ok: false,
        detail: {
          endpoint: adapter.endpoint,
          model: adapter.model,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  if (adapter.mode === "agent-cli") {
    const commandPath = Bun.which(adapter.command);
    return {
      adapterId,
      ok: Boolean(commandPath),
      detail: {
        driver: adapter.driver,
        command: adapter.command,
        command_path: commandPath ?? null,
        env_file: adapter.envFile ?? null,
        env_file_exists: adapter.envFile ? existsSync(adapter.envFile) : null,
        model: adapter.model ?? null,
        provider_base_url: adapter.providerBaseUrl ?? null
      }
    };
  }

  return {
    adapterId,
    ok: false,
    detail: {
      error: "unsupported_adapter_mode",
      mode: (adapter as { mode?: string }).mode ?? "unknown"
    }
  };
}

export async function executeWithAdapter(request: ExecutionRequest): Promise<AdapterExecutionResult> {
  if (request.adapterConfig.mode === "ollama-generate") {
    return executeWithOllama(request);
  }
  if (request.adapterConfig.mode === "agent-cli") {
    return executeWithAgentCli(request);
  }
  return {
    rawOutput: `Unsupported adapter mode: ${(request.adapterConfig as { mode?: string }).mode ?? "unknown"}`,
    exitStatus: "error",
    retryClass: "permanent"
  };
}
