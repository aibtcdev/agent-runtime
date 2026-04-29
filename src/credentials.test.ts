import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCredentialRefs } from "./credentials";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "credresolve-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeFakeSkillsRepo(passwordExpected: string, credentialMap: Record<string, string>): string {
  const skillsRepo = path.join(workDir, "skills-repo");
  mkdirSync(path.join(skillsRepo, "credentials"), { recursive: true });
  const script = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i+1];
}
if (args[0] !== "get") { console.error("only get supported"); process.exit(2); }
if (flags.password !== ${JSON.stringify(passwordExpected)}) { console.error("bad password"); process.exit(3); }
const map = ${JSON.stringify(credentialMap)};
if (!(flags.id in map)) { console.error("unknown id"); process.exit(4); }
console.log(JSON.stringify({ id: flags.id, value: map[flags.id] }));
`;
  const scriptPath = path.join(skillsRepo, "credentials", "credentials.ts");
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);
  return skillsRepo;
}

function writeHomeEnv(password: string | null): string {
  const file = path.join(workDir, ".env");
  writeFileSync(file, password === null ? "" : `CREDENTIALS_PASSWORD=${password}\n`, "utf8");
  return file;
}

describe("resolveCredentialRefs", () => {
  test("no credential refs is a no-op", async () => {
    const env = { OPENAI_BASE_URL: "https://api.example.com" };
    const result = await resolveCredentialRefs(env, {
      skillsRepo: writeFakeSkillsRepo("pw", {}),
      homeEnvFile: writeHomeEnv("pw")
    });
    expect(result).toEqual(env);
  });

  test("substitutes *_CREDENTIAL keys with fetched values", async () => {
    const env = {
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY_CREDENTIAL: "lumen-openrouter-key",
      ANTHROPIC_API_KEY_CREDENTIAL: "lumen-anthropic-key"
    };
    const result = await resolveCredentialRefs(env, {
      skillsRepo: writeFakeSkillsRepo("pw", {
        "lumen-openrouter-key": "sk-or-v1-fake",
        "lumen-anthropic-key": "sk-ant-fake"
      }),
      homeEnvFile: writeHomeEnv("pw")
    });
    expect(result.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(result.OPENROUTER_API_KEY).toBe("sk-or-v1-fake");
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-fake");
    expect(result.OPENROUTER_API_KEY_CREDENTIAL).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY_CREDENTIAL).toBeUndefined();
  });

  test("throws when CREDENTIALS_PASSWORD missing in home env", async () => {
    const env = { OPENROUTER_API_KEY_CREDENTIAL: "lumen-openrouter-key" };
    await expect(resolveCredentialRefs(env, {
      skillsRepo: writeFakeSkillsRepo("pw", { "lumen-openrouter-key": "sk-fake" }),
      homeEnvFile: writeHomeEnv(null)
    })).rejects.toThrow(/CREDENTIALS_PASSWORD/);
  });

  test("throws when home env file missing entirely", async () => {
    const env = { OPENROUTER_API_KEY_CREDENTIAL: "lumen-openrouter-key" };
    const skillsRepo = writeFakeSkillsRepo("pw", { "lumen-openrouter-key": "sk-fake" });
    const missingHome = path.join(workDir, "no-such-env");
    await expect(resolveCredentialRefs(env, {
      skillsRepo,
      homeEnvFile: missingHome
    })).rejects.toThrow(/not found/);
  });

  test("throws when skills repo missing", async () => {
    const env = { OPENROUTER_API_KEY_CREDENTIAL: "lumen-openrouter-key" };
    const homeEnvFile = writeHomeEnv("pw");
    await expect(resolveCredentialRefs(env, {
      skillsRepo: path.join(workDir, "no-such-repo"),
      homeEnvFile
    })).rejects.toThrow(/credentials skill missing/);
  });

  test("propagates credential subprocess error", async () => {
    const env = { OPENROUTER_API_KEY_CREDENTIAL: "missing-id" };
    await expect(resolveCredentialRefs(env, {
      skillsRepo: writeFakeSkillsRepo("pw", { "lumen-openrouter-key": "sk" }),
      homeEnvFile: writeHomeEnv("pw")
    })).rejects.toThrow(/missing-id/);
  });

  test("rejects empty credential id", async () => {
    const env = { OPENROUTER_API_KEY_CREDENTIAL: "" };
    await expect(resolveCredentialRefs(env, {
      skillsRepo: writeFakeSkillsRepo("pw", {}),
      homeEnvFile: writeHomeEnv("pw")
    })).rejects.toThrow(/empty/);
  });
});
