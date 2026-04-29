import type { CanonicalOutcome } from "../types";
import { parseAibtcHint } from "./aibtc";
import { parseGenericHint } from "./generic";
import { parseHiroHint } from "./hiro";

export type RetryHint = {
  afterSeconds: number;
  source: string;
};

type Parser = (outcome: CanonicalOutcome) => RetryHint | null;

const PARSERS: Record<string, Parser> = {
  aibtc: parseAibtcHint,
  hiro: parseHiroHint,
  generic: parseGenericHint
};

export function extractRetryHint(
  outcome: CanonicalOutcome,
  service?: string
): RetryHint | null {
  if (typeof outcome.retry_after_seconds === "number" && outcome.retry_after_seconds > 0) {
    return {
      afterSeconds: outcome.retry_after_seconds,
      source: outcome.retry_hint_source ?? service ?? "structured"
    };
  }

  if (service && PARSERS[service]) {
    const hit = PARSERS[service](outcome);
    if (hit) return hit;
  }

  return parseGenericHint(outcome);
}
