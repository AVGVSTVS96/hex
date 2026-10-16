import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub } from '../../channels/hub/hub.ts'

// The hub starts every session through bin/session, so this runs the hub's real launch
// against the real launcher, with a fake claude at the end that records what it was given.

const HEX = join(import.meta.dir, '../..')
const saved = { ...process.env }

let home: string
let hub: ReturnType<typeof startHub>
let listener: ReturnType<typeof Bun.serve>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'session-'))
  for (const dir of ['bin', 'chat', 'mods/scheduler']) cpSync(join(HEX, dir), join(home, '.hex', dir), { recursive: true })
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { HEX_MAIN_MODEL: 'claude-opus-5-5', MEMORY_DIR: join(home, 'memory') } }))
  mkdirSync(join(home, '.hex/vendor'))
  writeFileSync(join(home, '.hex/vendor/memo'), '#!/bin/sh\necho "#0 a memory"\n')
  chmodSync(join(home, '.hex/vendor/memo'), 0o755)
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Global\n')
  writeFileSync(join(home, 'AGENTS.md'), '- Keep it short.\n')
  mkdirSync(join(home, 'fake'))
  mkdirSync(join(home, 'config/jobs/job12345'), { recursive: true })
  writeFileSync(join(home, 'fake/claude'), `#!/bin/sh
[ "$1 $2" = "agents --json" ] && echo '[]' && exit 0
jq -cn '$ARGS.positional' --args -- "$@" > "${home}/launched.tmp" && mv "${home}/launched.tmp" "${home}/launched"
echo "backgrounded · job12345 · test"
exit 0
`)
  chmodSync(join(home, 'fake/claude'), 0o755)
  for (const name of Object.keys(process.env)) if (name.startsWith('HEX_')) delete process.env[name]
  Object.assign(process.env, { HOME: home, PATH: `${join(home, 'fake')}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_SECURESTORAGE_CONFIG_DIR: '', HEX_CHAT_CLAUDE: 'true' })
  listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 404 }) })
})

afterEach(() => {
  hub?.close()
  listener.stop(true)
  process.env = { ...saved }
})

async function launch(channel: string, thread: string, options: Partial<Parameters<typeof startHub>[0]> = {}, cwd?: string) {
  hub = startHub({
    stateDir: join(home, 'state'),
    channel,
    server: { title: 'Test', instructions: 'Messages arrive as <channel>.', tools: [] },
    port: listener.port,
    hexDir: home,
    launcher: join(home, '.hex/bin/session'),
    call: async () => 'sent',
    state: () => {},
    failed: (_, reason) => {
      throw new Error(reason)
    },
    ...options,
  })
  if (cwd) hub.open(thread, thread, 'hi', cwd)
  else hub.deliver(thread, thread, { content: 'hi', meta: {} })
  for (let i = 0; i < 200 && !existsSync(join(home, 'launched')); i++) await Bun.sleep(25)
  const args: string[] = JSON.parse(readFileSync(join(home, 'launched'), 'utf8'))
  const file = args[args.indexOf('--settings') + 1]!
  return { args, file, settings: JSON.parse(readFileSync(file, 'utf8')) }
}

test('a DM session the hub starts gets the chat prompt, and its settings, token included, stay in an owner-only file', async () => {
  const { args, file, settings } = await launch('plugin:telegram@hex', '6296842341', { fresh: () => true })
  expect(readFileSync(args[args.indexOf('--system-prompt-file') + 1]!, 'utf8')).toStartWith('You are hex')
  expect(settings.claudeMdExcludes).toContain(join(home, 'AGENTS.md'))
  expect(settings.env).toMatchObject({ HEX_FRESH: '1', HEX_THREAD: '6296842341', HEX_WAKE: join(home, 'state/wake/CLAUDE.md') })
  expect(settings.env.HEX_TOKEN).toBeString()
  expect(args.join(' ')).not.toContain(settings.env.HEX_TOKEN)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('General, started by the hub, runs the scheduler and the main model', async () => {
  const { args } = await launch('plugin:telegram@hex', '-100:1', { main: '-100:1', general: true })
  expect(args).toContain(join(home, '.hex/mods/scheduler'))
  expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5')
  expect(args).not.toContain('--system-prompt-file')
})

test('a voice session, started by the hub, runs the fast model on the 1-hour cache', async () => {
  const { settings } = await launch('plugin:voice@hex', 'voice', { main: 'voice', fresh: () => true, limits: { capacity: 0 } })
  expect(settings).toMatchObject({ model: 'claude-sonnet-5-5', effortLevel: 'low', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
})

test('a topic session, started by the hub, gets none of the chat or main additions', async () => {
  const { args, settings } = await launch('plugin:telegram@hex', '-100:5', { fresh: () => false })
  expect(args).not.toContain('--system-prompt-file')
  expect(args).not.toContain(join(home, '.hex/mods/scheduler'))
  expect(settings.claudeMdExcludes).toBeUndefined()
  expect(settings.env.HEX_THREAD).toBe('-100:5')
})

test('a session started in another project gets the hex folder\'s settings under the hub\'s, in its file', async () => {
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', permissions: { deny: ['Read(./.env)'] }, env: { MEMORY_DIR: join(home, 'memory') } }))
  const project = mkdtempSync(join(tmpdir(), 'project-'))
  const { args, settings } = await launch('plugin:t3@hex', 't3:1', {}, project)
  expect(settings).toMatchObject({ model: 'opus', permissions: { deny: [`Read(/${home}/.env)`] }, enabledPlugins: { 't3@hex': true }, env: { MEMORY_DIR: join(home, 'memory'), HEX_THREAD: 't3:1' } })
  expect(args).toContain('--append-system-prompt')
})
