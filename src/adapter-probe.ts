import type { AdapterConfig, RuntimeConfig } from "./types";

export type ProbeResult = {
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
};

const PROBE_CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

const cache = new Map<string, { result: ProbeResult; expiresAt: number }>();

export function clearAdapterProbeCache(): void {
  cache.clear();
}

async function probeUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (!response.ok && response.status >= 500) {
      return { ok: false, reason: `${url} returned ${response.status}`, detail: { status: response.status } };
    }
    return { ok: true, detail: { status: response.status, url } };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      detail: { url }
    };
  }
}

export async function probeAdapter(adapterId: string, config: RuntimeConfig): Promise<ProbeResult> {
  const cached = cache.get(adapterId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }
  const result = await probeAdapterFresh(adapterId, config);
  cache.set(adapterId, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
  return result;
}

async function probeAdapterFresh(adapterId: string, config: RuntimeConfig): Promise<ProbeResult> {
  const adapter: AdapterConfig | undefined = config.adapters[adapterId];
  if (!adapter) {
    return { ok: false, reason: `adapter not found: ${adapterId}` };
  }

  if (adapter.mode === "ollama-generate") {
    return probeUrl(`${adapter.endpoint.replace(/\/$/, "")}/api/tags`);
  }

  if (adapter.mode === "agent-cli") {
    const commandPath = Bun.which(adapter.command);
    if (!commandPath) {
      return { ok: false, reason: `command not found: ${adapter.command}`, detail: { command: adapter.command } };
    }
    if (adapter.providerBaseUrl) {
      return probeUrl(adapter.providerBaseUrl.replace(/\/$/, "") + "/models");
    }
    return { ok: true, detail: { command_path: commandPath } };
  }

  if (adapter.mode === "script") {
    const commandPath = Bun.which(adapter.command);
    if (!commandPath) {
      return { ok: false, reason: `command not found: ${adapter.command}`, detail: { command: adapter.command } };
    }
    return { ok: true, detail: { command_path: commandPath } };
  }

  return { ok: false, reason: `unknown adapter mode` };
}

export function getFallbackAdapterId(config: RuntimeConfig, adapterId: string): string | null {
  const adapter = config.adapters[adapterId] as AdapterConfig | undefined;
  if (!adapter) return null;
  const fallback = "fallback_adapter" in adapter ? adapter.fallback_adapter : undefined;
  if (!fallback) return null;
  if (fallback === adapterId) return null;
  if (!config.adapters[fallback]) return null;
  return fallback;
}

export async function selectAdapterWithFallback(
  config: RuntimeConfig,
  initialAdapterId: string,
  maxFallbacks = 3
): Promise<{ adapterId: string; chain: Array<{ adapterId: string; ok: boolean; reason?: string }>; }> {
  const chain: Array<{ adapterId: string; ok: boolean; reason?: string }> = [];
  let current = initialAdapterId;
  for (let i = 0; i <= maxFallbacks; i += 1) {
    const probe = await probeAdapter(current, config);
    chain.push({ adapterId: current, ok: probe.ok, reason: probe.reason });
    if (probe.ok) {
      return { adapterId: current, chain };
    }
    const next = getFallbackAdapterId(config, current);
    if (!next) {
      return { adapterId: current, chain };
    }
    current = next;
  }
  return { adapterId: current, chain };
}
