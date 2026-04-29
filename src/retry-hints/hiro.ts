import type { CanonicalOutcome } from "../types";
import type { RetryHint } from "./index";
import { parseGenericHint } from "./generic";

export function parseHiroHint(outcome: CanonicalOutcome): RetryHint | null {
  const haystack = `${outcome.operator_summary ?? ""}\n${outcome.raw_output ?? ""}`;
  if (!/hiro|stacks-api|api\.hiro/i.test(haystack) && !/429|too many requests/i.test(haystack)) {
    return null;
  }
  const generic = parseGenericHint(outcome);
  if (!generic) return null;
  return { afterSeconds: generic.afterSeconds, source: "hiro" };
}
