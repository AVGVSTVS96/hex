import { beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HEX = join(import.meta.dir, '../..')
const THREAD = '6296842341'
const CHANNEL = 'plugin:telegram@hex'

let home: string
let chat: string
let transcript: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chat-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/chat'))
  copyFileSync(join(HEX, 'bin/chat'), join(home, '.hex/bin/chat'))
  copyFileSync(join(HEX, 'bin/session'), join(home, '.hex/bin/session'))
  copyFileSync(join(HEX, 'chat/prompt.md'), join(home, '.hex/chat/prompt.md'))
  chat = join(home, 'chat', `telegram-${THREAD}`)
  transcript = join(home, 'transcript.jsonl')
  writeFileSync(join(home, 'calls'), '')
  // Answers a compaction with its <input> squeezed to a line; LONG makes the first try too long.
  writeFileSync(join(home, 'claude'), `#!/usr/bin/env python3
import json, os, re, sys
with open("${home}/calls", "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
tries = 0
for line in sys.stdin:
    text = json.loads(line)["message"]["content"]
    with open("${home}/calls", "a") as f:
        f.write(json.dumps({"prompt": text}) + "\\n")
    tries += 1
    found = re.search(r"<input>\\n([\\s\\S]*)\\n</input>", text)
    squeezed = " ".join((found[1] if found else text).split())[:60]
    reply = "x" * 700 if os.environ.get("LONG") and tries == 1 else ("long " * 110 if os.environ.get("LONG") and tries == 2 else "sum " + squeezed + " " + "~" * 240)
    print(json.dumps({"type": "result", "result": reply, "is_error": False}), flush=True)
`)
  chmodSync(join(home, 'claude'), 0o755)
})

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  HEX_FRESH: '1',
  HEX_CHANNEL: CHANNEL,
  HEX_THREAD: THREAD,
  HEX_CHAT_CLAUDE: join(home, 'claude'),
  ...extra,
})

function run(args: string[], input = '', extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([join(home, '.hex/bin/chat'), ...args], { stdin: Buffer.from(input), env: env(extra) })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

function write(records: object[]) {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 11, 16, i)).toISOString()
  writeFileSync(transcript, records.map((record, i) => JSON.stringify({ timestamp: at(i), ...record })).join('\n') + '\n')
}

const hook = () => JSON.stringify({ session_id: 's', transcript_path: transcript })

function messages() {
  return readdirSync(join(chat, 'main')).flatMap(file =>
    readFileSync(join(chat, 'main', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
}

function prompts(): string[] {
  return readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.prompt).map(call => call.prompt)
}

function mcp(requests: object[]) {
  const input = requests.map((request, id) => JSON.stringify({ jsonrpc: '2.0', id, ...request })).join('\n') + '\n'
  return run(['mcp', chat], input).trim().split('\n').map(line => JSON.parse(line).result)
}

const words = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

test('a turn logs the user, replies, tool calls and results, and agents\' reports, and leaves out thoughts, reminders and subagents', () => {
  write([
    { type: 'user', message: { content: `<channel source="telegram" chat_id="${THREAD}" message_id="9" user="bassim" user_id="1" ts="x" reply_to_text="earlier">is the fly credit still there?</channel>` } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'fly orgs list' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'credit: $500' }] }] } },
    { type: 'user', isSidechain: true, message: { content: 'a subagent step' } },
    { type: 'user', message: { content: '<system-reminder>be nice</system-reminder>' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: `<channel source="telegram" chat_id="${THREAD}" message_id="10" user="bassim">and the PR?</channel>` } },
    { type: 'user', message: { content: '<task-notification>[Scout] report: the PR is open</task-notification>' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__plugin_telegram_telegram__reply', input: { chat_id: THREAD, text: 'Yes, $500, and the PR is open.' } }] } },
  ])
  run(['begin'], hook())
  run(['log'], hook())
  expect(messages().map(m => [m.i, m.kind, m.text])).toEqual([
    [0, 'user', '(reply_to_text: earlier) is the fly credit still there?'],
    [1, 'hex', 'Checking.'],
    [2, 'tool', 'Bash {"command": "fly orgs list"}'],
    [3, 'echo', 'credit: $500'],
    [4, 'user', 'and the PR?'],
    [5, 'work', '<task-notification>[Scout] report: the PR is open</task-notification>'],
    [6, 'hex', 'Yes, $500, and the PR is open.'],
  ])
  expect(new Date(messages()[0].date).toISOString()).toBe('2026-10-11T16:00:00.000Z')
  run(['log'], hook())
  expect(messages()).toHaveLength(7)
})

test('outside a fresh thread the hooks do nothing', () => {
  write([{ type: 'user', message: { content: 'hi' } }])
  const result = Bun.spawnSync([join(home, '.hex/bin/chat'), 'log'], { stdin: Buffer.from(hook()), env: { ...env(), HEX_FRESH: '' } })
  expect(result.exitCode).toBe(0)
  expect(readdirSync(home)).not.toContain('chat')
})

test('a short message is its own node with no model call; a long one is compacted, with the chat before it as context', () => {
  write([
    { type: 'user', message: { content: 'short one' } },
    { type: 'user', message: { content: words(200) } },
  ])
  run(['begin'], hook())
  const system = run(['turn']).trim()
  const view = readFileSync(system, 'utf8')
  expect(view.startsWith(readFileSync(join(HEX, 'chat/prompt.md'), 'utf8'))).toBe(true)
  expect(view).toContain('<chat>\n0+1|user: short one\n1+1|sum user: word0 word1')
  expect(prompts()).toHaveLength(1)
  expect(prompts()[0]).toStartWith('<chat>\n0+1|user: short one\n</chat>\n\nCompaction: compress message 1 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n' + '-'.repeat(512) + '\n<input>\nuser: word0')
  expect(JSON.parse(readFileSync(join(home, 'calls'), 'utf8').split('\n')[0])).toEqual(expect.arrayContaining(['--safe-mode', '--model', 'opus', '--effort', 'xhigh', '--system-prompt-file', join(home, '.hex/chat/prompt.md')]))
})

test('a line over 512 bytes is sent back with the cut, and the shortest try is kept', () => {
  write([{ type: 'user', message: { content: words(200) } }])
  run(['begin'], hook())
  readFileSync(run(['turn'], '', { LONG: '1' }).trim(), 'utf8')
  const sent = prompts()
  expect(sent[1]).toStartWith('Too long: your line is 700 bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n' + 'x'.repeat(512) + '| ← LIMIT')
  expect(sent).toHaveLength(3)
  expect(run(['view', chat])).toMatch(/^<chat>\n0\+1\|sum /)
})

test('pairs merge into their parent, which zoom opens again, down to the message whole; date gives its time', () => {
  write(Array.from({ length: 4 }, (_, i) => ({ type: 'user', message: { content: words(120, `m${i}w`) } })))
  run(['begin'], hook())
  run(['turn'])
  run(['compact', chat])
  const tree = readdirSync(join(chat, 'tree')).flatMap(file => readFileSync(join(chat, 'tree', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  expect(tree.map(n => `${n.l}:${n.i}`).sort()).toEqual(['0:0', '0:1', '0:2', '0:3', '1:0', '1:1', '2:0'])
  expect(prompts().some(p => p.includes('Compaction: merge lines 0+1 and 1+1, adjacent'))).toBe(true)
  const [, list, two, one, when, wrong] = mcp([
    { method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'zoom', arguments: { id: 0, n: 4 } } },
    { method: 'tools/call', params: { name: 'zoom', arguments: { id: 2, n: 1 } } },
    { method: 'tools/call', params: { name: 'date', arguments: { id: 3 } } },
    { method: 'tools/call', params: { name: 'zoom', arguments: { id: 1, n: 2 } } },
  ])
  expect(list.tools.map((tool: { name: string }) => tool.name)).toEqual(['zoom', 'date'])
  expect(two.content[0].text).toMatch(/^0\+2\|sum .*\n2\+2\|sum /)
  expect(one.content[0].text).toBe(`user: ${words(120, 'm2w')}`)
  expect(when.content[0].text).toMatch(/^2026-10-11T/)
  expect(wrong.isError).toBe(true)
})

test('the view grows a line per message and, past 128 KB, merges the most due pairs down to 64 KB in one batch', () => {
  const out = Bun.spawnSync(['python3', '-I', '-B', '-c', `
import importlib.machinery, json, sys
chat = importlib.machinery.SourceFileLoader("chat", sys.argv[1]).load_module()
c = chat.Chat(sys.argv[2])
sizes, batches, stable, lows = [], 0, True, []
for t in range(1200):
    before = list(c.view)
    c.add("user", "y" * 300, "2026-10-11T00:00:00+00:00")
    while c.pending:
        l, i = min(c.pending)
        c.put(l, i, "z" * 400)
    if len(c.view) < len(before):
        batches += 1
        lows.append(c.weight(c.view))
    else:
        stable &= c.view[:len(before)] == before
    covered = 0
    for l, i in c.view:
        assert i << l == covered, (t, c.view)
        covered += 1 << l
    assert covered == t + 1
    sizes.append(c.weight(c.view))
print(json.dumps({"max": max(sizes), "batches": batches, "stable": stable, "lows": max(lows)}))
`, join(HEX, 'bin/chat'), join(home, 'sim')])
  const result = JSON.parse(out.stdout.toString() || out.stderr.toString())
  expect(result.max).toBeLessThanOrEqual(128_000 + 512)
  expect(result.batches).toBeGreaterThan(1)
  expect(result.stable).toBe(true)
  expect(result.lows).toBeLessThanOrEqual(64_000)
})

test('the most due pair is the one that ended longest ago in its own line size, the oldest of equals', () => {
  const out = Bun.spawnSync(['python3', '-I', '-B', '-c', `
import importlib.machinery, sys
chat = importlib.machinery.SourceFileLoader("chat", sys.argv[1]).load_module()
c = chat.Chat(sys.argv[2])
for t in range(10):
    c.messages.append({"i": t})
c.nodes = {p: "n" for p in [(0, i) for i in range(10)] + [(1, i) for i in range(5)] + [(2, 0), (2, 1), (3, 0)]}
lines = [(2, 0), (2, 1), (0, 8), (0, 9)]
c.fold(lines, 3)
print(lines)
`, join(HEX, 'bin/chat'), join(home, 'due')])
  expect(out.stdout.toString().trim()).toBe('[(2, 0), (2, 1), (1, 4)]')
})

test('a fresh session starts from the chat: the launcher adds the system prompt file and the zoom and date tools', () => {
  writeFileSync(join(home, '.claude-args'), '')
  mkdirSync(join(home, 'fake'))
  writeFileSync(join(home, 'fake/claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/.claude-args"\n`)
  chmodSync(join(home, 'fake/claude'), 0o755)
  write([{ type: 'user', message: { content: 'hello' } }])
  run(['begin'], hook())
  const launch = (settings: object) => {
    Bun.spawnSync([join(home, '.hex/bin/session'), '--bg', '--settings', JSON.stringify(settings)], {
      cwd: home,
      env: { ...process.env, PATH: `${join(home, 'fake')}:${process.env.PATH}`, HEX_CHAT_CLAUDE: join(home, 'claude') },
    })
    return readFileSync(join(home, '.claude-args'), 'utf8').trim().split('\n')
  }
  const args = launch({ env: { HEX_CHANNEL: CHANNEL, HEX_THREAD: THREAD, HEX_FRESH: '1' } })
  const system = args[args.indexOf('--append-system-prompt-file') + 1]!
  expect(readFileSync(system, 'utf8')).toContain('0+1|user: hello')
  expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { chat: { command: join(home, '.hex/bin/chat'), args: ['mcp', chat] } } })
  const plain = launch({ env: { HEX_CHANNEL: CHANNEL, HEX_THREAD: '-100:5' } })
  expect(plain).not.toContain('--append-system-prompt-file')
  expect(plain).not.toContain('--mcp-config')
})
