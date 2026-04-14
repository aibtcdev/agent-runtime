import type { Profile, RuntimeConfig } from "./types";

export async function loadProfile(config: RuntimeConfig, profileId: string): Promise<Profile> {
  const profilePath = config.profiles[profileId];
  if (!profilePath) {
    throw new Error(`Unknown profile: ${profileId}`);
  }

  const file = Bun.file(profilePath);
  if (!(await file.exists())) {
    throw new Error(`Profile file not found: ${profilePath}`);
  }

  return JSON.parse(await file.text()) as Profile;
}
