import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "./types";
import {
  clearAdapterProbeCache,
  getFallbackAdapterId,
  selectAdapterWithFallback,
  probeAdapter
} from "./adapter-probe";

afterEach(() => clearAdapterProbeCache());

function baseConfig(): RuntimeConfig {
  return {
    runtimeName: "test",
    runtimePolicy: "",
    stateDir: "/tmp/test-state",
    logDir: "/tmp/test-state/logs",
    artifactDir: "/tmp/test-state/artifacts",
    dbPath: "/tmp/test-state/runtime.db",
    lockPath: "/tmp/test-state/dispatch.lock",
    defaultProfile: "p",
    defaultAdapter: "primary",
    maxAttempts: 1,
    retryBackoffSeconds: 1,
    profiles: {},
    adapters: {}
  } as RuntimeConfig;
}

async function withMockFetch<T>(
  impl: (url: string) => Promise<Response> | Response,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => Promise.resolve(impl(String(url)))) as unknown as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("getFallbackAdapterId", () => {
  test("returns null when adapter has no fallback", () => {
    const cfg = baseConfig();
    cfg.adapters.solo = { mode: "ollama-generate", endpoint: "http://x", model: "m", timeoutMs: 1 };
    expect(getFallbackAdapterId(cfg, "solo")).toBeNull();
  });

  test("returns the fallback id when set and registered", () => {
    const cfg = baseConfig();
    cfg.adapters.primary = { mode: "ollama-generate", endpoint: "http://x", model: "m", timeoutMs: 1, fallback_adapter: "secondary" };
    cfg.adapters.secondary = { mode: "ollama-generate", endpoint: "http://y", model: "m", timeoutMs: 1 };
    expect(getFallbackAdapterId(cfg, "primary")).toBe("secondary");
  });

  test("ignores self-referential fallback", () => {
    const cfg = baseConfig();
    cfg.adapters.primary = { mode: "ollama-generate", endpoint: "http://x", model: "m", timeoutMs: 1, fallback_adapter: "primary" };
    expect(getFallbackAdapterId(cfg, "primary")).toBeNull();
  });

  test("ignores fallback to non-existent adapter", () => {
    const cfg = baseConfig();
    cfg.adapters.primary = { mode: "ollama-generate", endpoint: "http://x", model: "m", timeoutMs: 1, fallback_adapter: "ghost" };
    expect(getFallbackAdapterId(cfg, "primary")).toBeNull();
  });
});

describe("probeAdapter", () => {
  test("ollama-generate probe hits /api/tags", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = { mode: "ollama-generate", endpoint: "http://192.168.99.99:11434", model: "m", timeoutMs: 1 };
    let calledUrl = "";
    const result = await withMockFetch(async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }, () => probeAdapter("primary", cfg));
    expect(calledUrl).toBe("http://192.168.99.99:11434/api/tags");
    expect(result.ok).toBeTrue();
  });

  test("ollama-generate probe fails when fetch throws", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = { mode: "ollama-generate", endpoint: "http://192.168.99.99:11434", model: "m", timeoutMs: 1 };
    const result = await withMockFetch(async () => {
      throw new Error("ECONNREFUSED");
    }, () => probeAdapter("primary", cfg));
    expect(result.ok).toBeFalse();
    expect(result.reason).toContain("ECONNREFUSED");
  });

  test("agent-cli with providerBaseUrl probes that URL", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = {
      mode: "agent-cli",
      driver: "claude-code",
      command: "/bin/sh",
      timeoutMs: 1,
      providerBaseUrl: "http://192.168.99.99:11434/v1"
    };
    let calledUrl = "";
    const result = await withMockFetch(async (url) => {
      calledUrl = String(url);
      return new Response("[]", { status: 200 });
    }, () => probeAdapter("primary", cfg));
    expect(calledUrl).toBe("http://192.168.99.99:11434/v1/models");
    expect(result.ok).toBeTrue();
  });

  test("agent-cli without providerBaseUrl just checks command path", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = {
      mode: "agent-cli",
      driver: "claude-code",
      command: "/bin/sh",
      timeoutMs: 1
    };
    const result = await probeAdapter("primary", cfg);
    expect(result.ok).toBeTrue();
  });

  test("agent-cli with missing command path fails", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = {
      mode: "agent-cli",
      driver: "claude-code",
      command: "/no/such/command-xyz-12345",
      timeoutMs: 1
    };
    const result = await probeAdapter("primary", cfg);
    expect(result.ok).toBeFalse();
    expect(result.reason).toContain("command not found");
  });
});

describe("selectAdapterWithFallback", () => {
  test("returns primary when probe succeeds", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = {
      mode: "ollama-generate",
      endpoint: "http://192.168.99.99:11434",
      model: "m",
      timeoutMs: 1,
      fallback_adapter: "secondary"
    };
    cfg.adapters.secondary = { mode: "ollama-generate", endpoint: "http://other", model: "m", timeoutMs: 1 };
    const out = await withMockFetch(async () => new Response("{\"models\":[]}", { status: 200 }), () => selectAdapterWithFallback(cfg, "primary"));
    expect(out.adapterId).toBe("primary");
    expect(out.chain).toHaveLength(1);
    expect(out.chain[0].ok).toBeTrue();
  });

  test("falls through to secondary when primary unreachable", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = {
      mode: "ollama-generate",
      endpoint: "http://192.168.99.99:11434",
      model: "m",
      timeoutMs: 1,
      fallback_adapter: "secondary"
    };
    cfg.adapters.secondary = { mode: "ollama-generate", endpoint: "http://openrouter.test", model: "m", timeoutMs: 1 };
    const out = await withMockFetch(async (url) => {
      if (String(url).includes("192.168.99.99")) throw new Error("ECONNREFUSED");
      return new Response("{\"models\":[]}", { status: 200 });
    }, () => selectAdapterWithFallback(cfg, "primary"));
    expect(out.adapterId).toBe("secondary");
    expect(out.chain.map((c) => c.adapterId)).toEqual(["primary", "secondary"]);
    expect(out.chain[0].ok).toBeFalse();
    expect(out.chain[1].ok).toBeTrue();
  });

  test("returns last attempt when whole chain fails", async () => {
    const cfg = baseConfig();
    cfg.adapters.primary = {
      mode: "ollama-generate",
      endpoint: "http://192.168.99.99:11434",
      model: "m",
      timeoutMs: 1,
      fallback_adapter: "secondary"
    };
    cfg.adapters.secondary = { mode: "ollama-generate", endpoint: "http://openrouter.test", model: "m", timeoutMs: 1 };
    const out = await withMockFetch(async () => { throw new Error("ECONNREFUSED"); }, () => selectAdapterWithFallback(cfg, "primary"));
    expect(out.adapterId).toBe("secondary");
    expect(out.chain.every((c) => !c.ok)).toBeTrue();
  });

  test("stops if maxFallbacks exceeded", async () => {
    const cfg = baseConfig();
    cfg.adapters.a = { mode: "ollama-generate", endpoint: "http://a", model: "m", timeoutMs: 1, fallback_adapter: "b" };
    cfg.adapters.b = { mode: "ollama-generate", endpoint: "http://b", model: "m", timeoutMs: 1, fallback_adapter: "c" };
    cfg.adapters.c = { mode: "ollama-generate", endpoint: "http://c", model: "m", timeoutMs: 1 };
    const out = await withMockFetch(async () => { throw new Error("nope"); }, () => selectAdapterWithFallback(cfg, "a", 1));
    expect(out.chain.map((c) => c.adapterId)).toEqual(["a", "b"]);
  });
});
