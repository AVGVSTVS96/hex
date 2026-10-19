import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR = join(homedir(), '.claude', 'channels', 'voice')

// The plugin's own settings, its OpenAI and Twilio keys among them, over whatever the hub's
// environment carries: that comes from wherever the hub started, and a key rotated since stays
// there stale. They stay here: the hub's sessions inherit its environment.
function settings(): Record<string, string | undefined> {
  const file: Record<string, string> = {}
  try {
    for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
      if (match) file[match[1]!] = match[2]!
    }
  } catch {}
  return { ...process.env, ...file }
}

export const env = settings()
export const PORT = Number(env.VOICE_PORT ?? 8790)
