import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(homedir(), ".claude", "channels", "voice");

function pluginEnvFile() {
  try {
    return readFileSync(join(STATE_DIR, ".env"), "utf-8");
  } catch {
    return "";
  }
}

function pluginSettingsOverStaleHubEnv() {
  const file: Record<string, string> = {};

  for (const line of pluginEnvFile().split("\n")) {
    const [, key, value] = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/u.exec(line) ?? [];

    if (key !== undefined && value !== undefined) {
      file[key] = value;
    }
  }

  return { ...process.env, ...file };
}

export const env = pluginSettingsOverStaleHubEnv();
export const PORT = Number(env.VOICE_PORT ?? 8790);
