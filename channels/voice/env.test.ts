import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test("the plugin's own settings win over a key the hub's environment still carries", () => {
  const home = mkdtempSync(join(tmpdir(), 'voice-env-'))
  try {
    mkdirSync(join(home, '.claude', 'channels', 'voice'), { recursive: true })
    writeFileSync(join(home, '.claude', 'channels', 'voice', '.env'), 'OPENAI_API_KEY=current\n')
    const read = `import { env } from ${JSON.stringify(join(import.meta.dir, 'env.ts'))}
console.log(env.OPENAI_API_KEY, env.VOICE_PUBLIC_URL)`
    const run = Bun.spawnSync(['bun', '-e', read], { env: { ...process.env, HOME: home, OPENAI_API_KEY: 'revoked', VOICE_PUBLIC_URL: 'voice.test' } })
    expect(run.stdout.toString().trim()).toBe('current voice.test')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
