import { existsSync } from "node:fs";
import path from "node:path";

import { parseEnvFile } from "./envfile";
import type { LoadedEnv } from "./envfile";

const CREDENTIAL_SUFFIX = "_CREDENTIAL";

type CredentialResolverOptions = {
  skillsRepo?: string;
  homeEnvFile?: string;
};

function defaultSkillsRepo(): string {
  const home = process.env.HOME ?? "";
  return path.join(home, ".claude", "skills", "skills-repo");
}

function defaultHomeEnvFile(): string {
  const home = process.env.HOME ?? "";
  return path.join(home, ".env");
}

async function fetchCredential(
  skillsRepo: string,
  credentialId: string,
  password: string
): Promise<string> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      path.join(skillsRepo, "credentials", "credentials.ts"),
      "get",
      "--id",
      credentialId,
      "--password",
      password
    ],
    cwd: skillsRepo,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`credential fetch failed for "${credentialId}": ${stderr.trim() || `exit ${proc.exitCode}`}`);
  }
  let parsed: { value?: string };
  try {
    parsed = JSON.parse(stdout) as { value?: string };
  } catch {
    throw new Error(`credential fetch returned non-JSON for "${credentialId}"`);
  }
  if (typeof parsed.value !== "string" || parsed.value.length === 0) {
    throw new Error(`credential "${credentialId}" has no value`);
  }
  return parsed.value;
}

export async function resolveCredentialRefs(
  env: LoadedEnv,
  options: CredentialResolverOptions = {}
): Promise<LoadedEnv> {
  const credentialKeys = Object.keys(env).filter((key) => key.endsWith(CREDENTIAL_SUFFIX));
  if (credentialKeys.length === 0) {
    return env;
  }

  const skillsRepo = options.skillsRepo ?? defaultSkillsRepo();
  if (!existsSync(path.join(skillsRepo, "credentials", "credentials.ts"))) {
    throw new Error(`credentials skill missing at ${skillsRepo}/credentials/credentials.ts; cannot resolve *_CREDENTIAL refs`);
  }

  const homeEnvFile = options.homeEnvFile ?? defaultHomeEnvFile();
  if (!existsSync(homeEnvFile)) {
    throw new Error(`cannot resolve *_CREDENTIAL refs: ${homeEnvFile} not found`);
  }
  const homeEnv = parseEnvFile(homeEnvFile);
  const password = homeEnv.CREDENTIALS_PASSWORD;
  if (!password) {
    throw new Error(`cannot resolve *_CREDENTIAL refs: CREDENTIALS_PASSWORD missing in ${homeEnvFile}`);
  }

  const resolved: LoadedEnv = { ...env };
  for (const credKey of credentialKeys) {
    const credentialId = env[credKey];
    if (!credentialId) {
      throw new Error(`${credKey} is empty; expected a credential id`);
    }
    const baseKey = credKey.slice(0, -CREDENTIAL_SUFFIX.length);
    const value = await fetchCredential(skillsRepo, credentialId, password);
    resolved[baseKey] = value;
    delete resolved[credKey];
  }
  return resolved;
}
