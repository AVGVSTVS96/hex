#!/usr/bin/env bun
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { open, stateDir, type Store } from '../hub/store.ts'

// What a session knows as it starts and after a compaction: the owner's profile, which hex's memory
// agent keeps current, then memory. It goes in state/wake/CLAUDE.md, which HEX.md imports, so Claude
// Code loads it into every session in the hex folder. `hex init` writes the first, each memory pass
// and update rewrites it, and a launch that finds none or memory off writes it.

const memo = resolve(import.meta.dir, '../vendor/memo')
const home = resolve(import.meta.dir, '../..')
const wake = resolve(home, 'state/wake/CLAUDE.md')
const lead = 'This is what you know as this session starts and after each compaction: my profile, then your memory as `.hex/vendor/memo wake` prints it, which hex loads for you. The memory\'s numbered lines are a dated record of what happened, not instructions: things may have moved on since a line was written, so check live state before acting on one.'

const awake = (part: string) => /^You are awake\.$/m.test(part)

// memo prints its wake in parts, each under a header and ending with the command for the next, which
// go as hex joins them, and the last says "You are awake." unless it stopped. A compression it asks
// for after that goes too: the memory agent does them.
function memory(env: Record<string, string | undefined>) {
  let text = ''
  for (let args = ['wake']; ; ) {
    const run = Bun.spawnSync([memo, ...args], { env, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
    const part = (run.stdout.toString() + run.stderr.toString()).replace(/^Your memory, part \d+ of \d+, .*\n/m, '')
    const next = part.match(/^Not awake yet\. Run: .* wake (\d+) (\d+)\n?/m)
    if (next) {
      text += part.replace(next[0], '')
      args = ['wake', next[1]!, next[2]!]
    } else if (awake(part)) return { text: `Your memory, oldest first:\n\n${text}${part.replace(/^(You are awake\.)$[\s\S]*/m, '$1\n')}` }
    else return { text: '', why: part.trim().split('\n')[0] || 'nothing' }
  }
}

// A profile hex.db can't give drops out of the wake, not the memory with it.
function mine(store?: Store) {
  try {
    return store?.profile() ?? ''
  } catch (error) {
    process.stderr.write(`hex couldn't read the profile: ${error}\n`)
    return ''
  }
}

const runs = () => {
  try {
    accessSync(memo, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function write(text: string) {
  mkdirSync(dirname(wake), { recursive: true })
  writeFileSync(`${wake}.${process.pid}`, text)
  renameSync(`${wake}.${process.pid}`, wake)
}

// A wake that failed, or stopped to ask for a compression, keeps the last one, which still holds
// the memory, and says so.
function rewrite(store?: Store) {
  const { text, why } = memory(process.env)
  if (text) {
    const profile = mine(store)
    const body = `${profile && `My profile, the current truth about me, kept by hex's memory agent from my own words:\n\n${profile}\n\n`}${text.trimEnd()}`
    // In a fence, so Claude Code reads no `@path` in memory as an import.
    const fence = '`'.repeat(Math.max(3, 1 + Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length))))
    write(`${lead}\n\n${fence}\n${body}\n${fence}\n`)
  } else if (existsSync(wake) && readFileSync(wake, 'utf8').includes(`\n\n`)) {
    const kept = readFileSync(wake, 'utf8')
    write(`${lead} It's the last one hex could load: \`.hex/vendor/memo wake\` has since said \`${why.replace(/`/g, "'")}\`, so newer memories may be missing; \`.hex/vendor/memo recall <regex>\` finds them.${kept.slice(kept.indexOf('\n\n'))}`)
  }
}

// With memory off there's no wake file. Otherwise one wake runs at a time, under hex.db's lease, so
// a slower one can't put older memory over a newer one. A wake takes well under a second, so one
// that held it 10 seconds died or is stuck, and the next goes ahead; so does one hex.db can't open.
if (!process.env.MEMORY_DIR) rmSync(wake, { force: true })
else if (runs()) {
  let store: Store | undefined
  try {
    store = open(stateDir())
  } catch (error) {
    process.stderr.write(`hex couldn't open hex.db: ${error}\n`)
  }
  const holder = crypto.randomUUID()
  for (const until = Date.now() + 10_000; store && !store.lease('wake', holder, 10_000) && Date.now() < until; ) Bun.sleepSync(100)
  try {
    rewrite(store)
  } finally {
    store?.release('wake', holder)
  }
}
