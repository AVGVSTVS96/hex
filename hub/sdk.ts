import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { createServer, connect } from 'net'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { runtime, type SDKBridge } from './sdk-config.ts'

const [mode, file, ...args] = process.argv.slice(2)
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const valueFlags = new Set(['--name', '-n', '--settings', '--model', '--effort', '--permission-mode', '--add-dir', '--disallowedTools', '--channels', '--resume', '--system-prompt-file', '--append-system-prompt', '--plugin-dir'])
function opening(argv: string[]) {
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (valueFlags.has(argv[i]!)) { i++; continue }
    if (!argv[i]!.startsWith('-')) words.push(argv[i]!)
  }
  return words.join(' ')
}
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
const flags = (argv: string[], flag: string) => argv.flatMap((word, i) => word === flag ? [argv[i + 1]!] : [])
const flag = (argv: string[], name: string) => flags(argv, name).at(-1)

if (mode === 'launch') {
  const config: SDKBridge = read(file!)
  if (await runtime(config) === 'interactive') {
    const child = Bun.spawn(['claude', ...args], { stdio: ['inherit', 'inherit', 'inherit'] })
    process.exit(await child.exited)
  }
  const settings = flag(args, '--settings')
  if (!settings || !existsSync(settings)) throw new Error('SDK topic needs a settings file')
  const home = read(settings).env.HEX_STORE
  const dir = join(home, 'sdk')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const launch = join(dir, `${randomUUID()}.json`)
  writeFileSync(launch, JSON.stringify({ config: file, args, cwd: process.cwd() }), { mode: 0o600 })
  const command = [process.execPath, import.meta.path, 'run', launch].map(quote).join(' ')
  const child = Bun.spawn(['claude', '--bg', '--name', flag(args, '--name') ?? flag(args, '-n') ?? 'hex SDK', '--exec', command], { stdio: ['inherit', 'inherit', 'inherit'] })
  process.exit(await child.exited)
}

if (mode !== 'run' || !file) throw new Error('usage: sdk.ts launch <config> <claude flags> | run <launch>')
const launch = read(file)
const argv: string[] = launch.args
const config: SDKBridge = read(launch.config)
const settingsFile = flag(argv, '--settings')!
const settings = read(settingsFile)
const env = { ...process.env, ...settings.env, ...config.env }
// An explicit key and prefixed model isolate every SDK request from OAuth pool members.
if (!env.ANTHROPIC_API_KEY || !config.prefix) throw new Error('SDK topic has no API key or model prefix')
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_AGENT_SDK_CLIENT_APP']) delete env[name]
env.ANTHROPIC_BASE_URL = config.proxy
env.ANTHROPIC_CUSTOM_HEADERS = 'X-Proxy-API-Only: 1'
const jobDir = process.env.CLAUDE_JOB_DIR
if (!jobDir) throw new Error('SDK topic needs its background shell job')
const session = read(join(jobDir, 'state.json')).sessionId
const metadata = join(jobDir, 'hex-sdk.json')
const state: Record<string, unknown> = { settings: settingsFile, flags: argv, status: 'idle', state: 'done' }
function status(working: boolean) {
  Object.assign(state, { status: working ? 'busy' : 'idle', state: state.state === 'failed' ? 'failed' : working ? 'working' : 'done' })
  writeFileSync(metadata + '.tmp', JSON.stringify(state), { mode: 0o600 })
  renameSync(metadata + '.tmp', metadata)
}
status(false)
const app = env.HEX_CHANNEL.match(/^plugin:([^@]+)/)?.[1]
if (!app) throw new Error('SDK topic has no channel')
const url = new URL(`/${app}`, `http://127.0.0.1:${env.HEX_PORT}`)
const headers = { Authorization: `Bearer ${env.HEX_TOKEN}`, 'X-Hex-Channel': env.HEX_CHANNEL, 'X-Hex-Thread': env.HEX_THREAD }
const client = new Client({ name: 'hex-agent-sdk', version: '1.0.0' })
const waiting: SDKUserMessage[] = []
let wake: (() => void) | undefined
let over = false
const permissions = new Map<string, (behavior: string) => void>()
function tell(message: object) {
  const socket = connect(env.HEX_HUB, () => socket.end(JSON.stringify(message) + '\n'))
  socket.on('error', error => console.error(`SDK topic couldn't reach its hub: ${error.message}`))
}
function fallback(continuing: boolean) {
  if (over) return
  over = true
  tell({ type: 'sdk-fallback', thread: env.HEX_THREAD, session, continuing })
  wake?.()
}
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const channelMessage = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) })
let delivery = Promise.resolve()
client.setNotificationHandler(channelMessage, message => {
  delivery = delivery.then(async () => {
    if (over) return
    if (await runtime(config) === 'interactive') return fallback(false)
    const attrs = Object.entries(message.params.meta ?? {}).map(([name, value]) => `${name}="${escape(value)}"`).join(' ')
    waiting.push({ type: 'user', session_id: session, parent_tool_use_id: null, message: { role: 'user', content: `<channel source="${app}" ${attrs}>\n${message.params.content}\n</channel>` } })
    wake?.()
  }).catch(error => { console.error(error.message); fallback(false) })
})
client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel/permission'), params: z.object({ request_id: z.string(), behavior: z.string() }) }), message => permissions.get(message.params.request_id)?.(message.params.behavior))
client.setNotificationHandler(z.object({ method: z.literal('notifications/tools/list_changed') }), async () => { await client.listTools() })
async function* input(): AsyncGenerator<SDKUserMessage> {
  while (!over) {
    if (!waiting.length) await new Promise<void>(resolve => { wake = resolve })
    for (const message of waiting.splice(0)) {
      status(true)
      yield message
    }
  }
}
const system = flag(argv, '--system-prompt-file')
const append = flags(argv, '--append-system-prompt').join('\n')
const prompt = system ? readFileSync(system, 'utf8') + append : { type: 'preset' as const, preset: 'claude_code' as const, append }
// The channel tools stay on the hub; only inbound message delivery uses SDK streaming input.
const privateSettings = join(jobDir, 'sdk-settings.json')
const selected = flag(argv, '--model') ?? settings.model ?? 'opus'
const model = selected.startsWith('claude-') ? selected : config.models[selected]
if (!model) throw new Error(`SDK bridge has no API model for ${selected}`)
writeFileSync(privateSettings, JSON.stringify({ ...settings, env: { ...settings.env, ...config.env, ANTHROPIC_BASE_URL: config.proxy, ANTHROPIC_CUSTOM_HEADERS: 'X-Proxy-API-Only: 1', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '' }, enabledPlugins: { ...settings.enabledPlugins, [env.HEX_CHANNEL.replace(/^plugin:/, '')]: false } }), { mode: 0o600 })
const sdk = query({ prompt: input(), options: {
  cwd: launch.cwd,
  pathToClaudeCodeExecutable: Bun.which('claude')!,
  env,
  settings: privateSettings,
  settingSources: ['user', 'project', 'local'],
  systemPrompt: prompt,
  model: `${config.prefix}/${model}`,
  effort: flag(argv, '--effort') as any,
  permissionMode: flag(argv, '--permission-mode') as any,
  allowDangerouslySkipPermissions: flag(argv, '--permission-mode') === 'bypassPermissions',
  additionalDirectories: flags(argv, '--add-dir'),
  disallowedTools: flags(argv, '--disallowedTools').flatMap(value => value.split(',')),
  plugins: flags(argv, '--plugin-dir').map(path => ({ type: 'local' as const, path })),
  sessionId: session,
  ...(flag(argv, '--resume') ? { resume: flag(argv, '--resume'), forkSession: true } : {}),
  extraArgs: { 'system-prompt-snapshot': 'off' },
  mcpServers: { [app]: { type: 'http', url: url.toString(), headers: { ...headers, 'X-Hex-Tools-Only': '1' } } },
  canUseTool: (name, args, options) => new Promise(resolve => {
    const id = randomUUID()
    const done = (behavior: string) => { permissions.delete(id); resolve(behavior === 'allow' ? { behavior: 'allow', updatedInput: args } : { behavior: 'deny', message: 'The owner denied this tool.' }) }
    permissions.set(id, done)
    options.signal.addEventListener('abort', () => done('deny'), { once: true })
    void client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: id, tool_name: name, description: `Allow ${name}?`, input_preview: JSON.stringify(args) } }).catch(() => done('deny'))
  }),
} })
const controlPath = join(jobDir, 'hex-sdk.sock')
rmSync(controlPath, { force: true })
const control = createServer(socket => socket.once('data', () => void sdk.interrupt().then(() => socket.end('interrupted\n')).catch(() => socket.end('failed\n')))).listen(controlPath)
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { over = true; wake?.(); sdk.close(); void client.close() })
let billing = false
try {
  await sdk.initializationResult()
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
  await client.listTools()
  const first = opening(argv)
  if (first) {
    waiting.unshift({ type: 'user', session_id: session, parent_tool_use_id: null, message: { role: 'user', content: first } }); wake?.()
  }
  for await (const message of sdk) {
    if (message.type === 'assistant' && message.error === 'billing_error') billing = true
    if (message.type === 'result') {
      status(false)
      if (billing || ('api_error_status' in message && message.api_error_status === 409)) { fallback(true); break }
      if (message.is_error) console.error(`SDK topic turn failed: ${message.subtype}`)
    }
  }
} catch (error) {
  if (!over) {
    console.error(`SDK topic failed: ${error instanceof Error ? error.message : error}`)
    state.state = 'failed'
    process.exitCode = 1
  }
} finally {
  over = true
  wake?.()
  sdk.close()
  await client.close()
  control.close()
  rmSync(metadata, { force: true })
  rmSync(controlPath, { force: true })
}
