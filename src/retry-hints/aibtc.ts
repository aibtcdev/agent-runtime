import type { CanonicalOutcome } from "../types";
import type { RetryHint } from "./index";

const SECONDS_PATTERN = /(?:check in again|try again|retry)\s+in\s+(\d+)\s*(?:seconds?|s)\b/i;

export function parseAibtcHint(outcome: CanonicalOutcome): RetryHint | null {
  const summary = outcome.operator_summary ?? "";
  const raw = outcome.raw_output ?? "";

  if (!/rate limit|too many requests|throttl/i.test(summary) && !/rate limit|too many requests|throttl/i.test(raw)) {
    return null;
  }

  const match = SECONDS_PATTERN.exec(summary) ?? SECONDS_PATTERN.exec(raw);
  if (!match) {
    return null;
  }

  const seconds = Number.parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return { afterSeconds: seconds, source: "aibtc" };
}
