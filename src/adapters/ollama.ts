import type { AdapterExecutionResult, ExecutionRequest } from "../types";

export async function executeWithOllama(request: ExecutionRequest): Promise<AdapterExecutionResult> {
  if (request.adapterConfig.mode !== "ollama-generate") {
    throw new Error(`Invalid adapter mode for Ollama execution: ${request.adapterConfig.mode}`);
  }
  const adapter = request.adapterConfig;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), adapter.timeoutMs);

  try {
    const response = await fetch(`${adapter.endpoint}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: adapter.model,
        prompt: request.assembledContext,
        stream: false,
        format: "json"
      }),
      signal: controller.signal
    });

    const body = await response.json() as Record<string, unknown>;
    const responseText = typeof body.response === "string" ? body.response : "";
    const thinkingText = typeof body.thinking === "string" ? body.thinking : "";
    const rawOutput = responseText || thinkingText || JSON.stringify(body);

    if (!response.ok) {
      return {
        rawOutput,
        exitStatus: "error",
        retryClass: response.status >= 500 ? "retryable" : "permanent",
        diagnostics: { http_status: response.status }
      };
    }

    return {
      rawOutput,
      exitStatus: "ok",
      retryClass: "none",
      diagnostics: { model: adapter.model }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = message.includes("aborted");
    return {
      rawOutput: message,
      exitStatus: timedOut ? "timeout" : "error",
      retryClass: "retryable",
      diagnostics: { error: message }
    };
  } finally {
    clearTimeout(timeout);
  }
}
