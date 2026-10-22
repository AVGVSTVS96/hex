import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, symlinkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'budget-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  for (const script of ['budget', 'identity']) copyFileSync(join(BIN, script), join(home, '.hex/bin', script))
  symlinkSync(join(BIN, '../hub'), join(home, '.hex/hub'))
  writeFileSync(join(home, 'AGENTS.md'), '@.hex/HEX.md\n@SOUL.md\n\n- Keep it short.\n')
  writeFileSync(join(home, 'SOUL.md'), '# Who you are\n\nA sharp friend.\n')
  writeFileSync(join(home, '.hex/HEX.md'), `# How you work\n\n${'word '.repeat(500)}\n`)
})
afterEach(() => rmSync(home, { recursive: true }))

function hook(tool_name: string, tool_input: object, budget = '20') {
  const run = Bun.spawnSync([join(home, '.hex/bin/budget')], {
    stdin: Buffer.from(JSON.stringify({ hook_event_name: tool_name === 'Bash' ? 'PostToolUse' : 'PreToolUse', tool_name, tool_input })),
    env: { ...env, HEX_RULES_WORDS: budget },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out ? JSON.parse(out) : null
}

const edit = (old_string: string, new_string: string, file = 'AGENTS.md') => hook('Edit', { file_path: join(home, file), old_string, new_string })

test('an edit within the budget goes through', () => {
  expect(edit('- Keep it short.', '- Keep it short and plain.')).toBeNull()
})

test('an edit past the budget is refused, with the numbers and what to do instead', () => {
  const out = edit('- Keep it short.', '- Keep it short.\n- Always add one more long rule for this one moment.')
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('AGENTS.md and SOUL.md from 13 to 24 words, over the 20')
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Work the change into the line it belongs to')
})

test('imported files count, and hex\'s own files under .hex/ do not', () => {
  expect(edit('A sharp friend.', 'A sharp friend who knows my whole setup, my machines and more.', 'SOUL.md').hookSpecificOutput.permissionDecision).toBe('deny')
  expect(hook('Edit', { file_path: join(home, '.hex/HEX.md'), old_string: '# How', new_string: `# How ${'more '.repeat(100)}` })).toBeNull()
})

test('a new import counts the words of the file it brings in', () => {
  writeFileSync(join(home, 'prefs.md'), `${'- rule\n'.repeat(10)}`)
  expect(edit('- Keep it short.', '- Keep it short.\n@prefs.md').hookSpecificOutput.permissionDecisionReason).toContain('AGENTS.md, SOUL.md, and prefs.md from 13 to 34 words')
})

test('writing a file AGENTS.md already imports counts it', () => {
  writeFileSync(join(home, 'AGENTS.md'), '@.hex/HEX.md\n@SOUL.md\n@prefs.md\n')
  expect(hook('Write', { file_path: join(home, 'prefs.md'), content: `${'- rule\n'.repeat(20)}` }).hookSpecificOutput.permissionDecision).toBe('deny')
})

test('files already over the budget can always get shorter', () => {
  expect(hook('Edit', { file_path: join(home, 'AGENTS.md'), old_string: '- Keep it short.', new_string: '- Short.' }, '5')).toBeNull()
  expect(hook('Edit', { file_path: join(home, 'AGENTS.md'), old_string: '- Keep it short.', new_string: '- Keep it short, please.' }, '5').hookSpecificOutput.permissionDecision).toBe('deny')
})

test('a whole-file write counts its new text', () => {
  expect(hook('Write', { file_path: join(home, 'AGENTS.md'), content: `@.hex/HEX.md\n@SOUL.md\n\n${'- rule\n'.repeat(20)}` }).hookSpecificOutput.permissionDecision).toBe('deny')
})

test('a shell command that left the files over the budget is told to cut them back', () => {
  writeFileSync(join(home, 'AGENTS.md'), `@.hex/HEX.md\n@SOUL.md\n\n${'- rule\n'.repeat(20)}`)
  expect(hook('Bash', { command: `echo '- rule' >> ${join(home, 'AGENTS.md')}` }).reason).toContain('now 49 words, over the 20')
  expect(hook('Bash', { command: 'ls' })).toBeNull()
})
