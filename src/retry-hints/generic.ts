import type { CanonicalOutcome } from "../types";
import type { RetryHint } from "./index";

const PATTERNS: RegExp[] = [
  /retry-after[:=\s]+(\d+)\s*(?:seconds?|s)?\b/i,
  /retry\s+(?:in|after)\s+(\d+)\s*(?:seconds?|s)\b/i,
  /try\s+again\s+(?:in|after)\s+(\d+)\s*(?:seconds?|s)\b/i,
  /wait\s+(\d+)\s*(?:seconds?|s)\s+(?:before|to)/i
];

export function parseGenericHint(outcome: CanonicalOutcome): RetryHint | null {
  const haystack = `${outcome.operator_summary ?? ""}\n${outcome.raw_output ?? ""}`;
  for (const pattern of PATTERNS) {
    const match = pattern.exec(haystack);
    if (!match) continue;
    const seconds = Number.parseInt(match[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return { afterSeconds: seconds, source: "generic" };
    }
  }
  return null;
}
