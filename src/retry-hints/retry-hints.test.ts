import { describe, expect, test } from "bun:test";
import type { CanonicalOutcome } from "../types";
import { extractRetryHint } from "./index";
import { parseAibtcHint } from "./aibtc";
import { parseGenericHint } from "./generic";
import { parseHiroHint } from "./hiro";

function blockedOutcome(operator_summary: string, raw_output?: string): CanonicalOutcome {
  return {
    status: "blocked",
    operator_summary,
    machine_status: "blocked",
    raw_output: raw_output ?? operator_summary
  };
}

describe("aibtc parser", () => {
  test("parses real Forge/Spark/Lumen outcome strings", () => {
    const cases = [
      { input: "AIBTC heartbeat rejected: Rate limit exceeded. You can check in again in 5 seconds.", expected: 5 },
      { input: "AIBTC heartbeat rejected: Rate limit exceeded. You can check in again in 19 seconds.", expected: 19 },
      { input: "AIBTC heartbeat rejected: Rate limit exceeded. You can check in again in 29 seconds.", expected: 29 }
    ];
    for (const { input, expected } of cases) {
      const hit = parseAibtcHint(blockedOutcome(input));
      expect(hit).not.toBeNull();
      expect(hit!.afterSeconds).toBe(expected);
      expect(hit!.source).toBe("aibtc");
    }
  });

  test("returns null when no rate-limit signal", () => {
    expect(parseAibtcHint(blockedOutcome("Some other failure happened"))).toBeNull();
  });

  test("returns null when rate-limit signal but no seconds", () => {
    expect(parseAibtcHint(blockedOutcome("AIBTC rate limit exceeded"))).toBeNull();
  });

  test("rejects zero or negative seconds", () => {
    expect(parseAibtcHint(blockedOutcome("Rate limit exceeded. Try again in 0 seconds."))).toBeNull();
  });
});

describe("generic parser", () => {
  test("parses HTTP retry-after header style", () => {
    const hit = parseGenericHint(blockedOutcome("Server replied retry-after: 30"));
    expect(hit?.afterSeconds).toBe(30);
    expect(hit?.source).toBe("generic");
  });

  test("parses 'retry in N seconds'", () => {
    const hit = parseGenericHint(blockedOutcome("Please retry in 45 seconds"));
    expect(hit?.afterSeconds).toBe(45);
  });

  test("parses 'wait N seconds before'", () => {
    const hit = parseGenericHint(blockedOutcome("Wait 15 seconds before retrying"));
    expect(hit?.afterSeconds).toBe(15);
  });

  test("returns null when no pattern matches", () => {
    expect(parseGenericHint(blockedOutcome("Network timeout"))).toBeNull();
  });
});

describe("hiro parser", () => {
  test("parses when hiro/stacks signal is present", () => {
    const hit = parseHiroHint(blockedOutcome("api.hiro.so 429 too many requests, retry in 60 seconds"));
    expect(hit?.afterSeconds).toBe(60);
    expect(hit?.source).toBe("hiro");
  });

  test("returns null without hiro signal", () => {
    expect(parseHiroHint(blockedOutcome("retry in 30 seconds"))).toBeNull();
  });
});

describe("extractRetryHint", () => {
  test("prefers structured retry_after_seconds field", () => {
    const outcome: CanonicalOutcome = {
      status: "blocked",
      operator_summary: "anything",
      machine_status: "blocked",
      retry_after_seconds: 7,
      retry_hint_source: "upstream"
    };
    const hit = extractRetryHint(outcome, "aibtc");
    expect(hit).toEqual({ afterSeconds: 7, source: "upstream" });
  });

  test("uses service-specific parser when provided", () => {
    const outcome = blockedOutcome("AIBTC heartbeat rejected: Rate limit exceeded. You can check in again in 12 seconds.");
    const hit = extractRetryHint(outcome, "aibtc");
    expect(hit?.afterSeconds).toBe(12);
    expect(hit?.source).toBe("aibtc");
  });

  test("falls through to generic when service parser misses", () => {
    const outcome = blockedOutcome("retry-after: 22");
    const hit = extractRetryHint(outcome, "aibtc");
    expect(hit?.afterSeconds).toBe(22);
    expect(hit?.source).toBe("generic");
  });

  test("returns null when no hint anywhere", () => {
    expect(extractRetryHint(blockedOutcome("Random failure"), "aibtc")).toBeNull();
  });

  test("falls back to generic when no service is specified", () => {
    const outcome = blockedOutcome("Please wait 90 seconds before retrying");
    const hit = extractRetryHint(outcome);
    expect(hit?.afterSeconds).toBe(90);
  });
});
