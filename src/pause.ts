import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "./types";

export type DispatchPauseState = {
  paused: boolean;
  reason: string | null;
  updated_at: string | null;
};

function pausePath(config: RuntimeConfig): string {
  return path.join(config.stateDir, "dispatch.paused.json");
}

export function readDispatchPause(config: RuntimeConfig): DispatchPauseState {
  const filePath = pausePath(config);
  if (!existsSync(filePath)) {
    return { paused: false, reason: null, updated_at: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return {
      paused: parsed.paused === true,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason : null,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : null
    };
  } catch {
    return { paused: true, reason: "pause file unreadable", updated_at: null };
  }
}

export function writeDispatchPause(
  config: RuntimeConfig,
  paused: boolean,
  reason?: string | null
): DispatchPauseState {
  const filePath = pausePath(config);
  if (!paused) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return { paused: false, reason: null, updated_at: new Date().toISOString() };
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const state = {
    paused: true,
    reason: reason?.trim() || null,
    updated_at: new Date().toISOString()
  };
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}
