#!/usr/bin/env bun
import { join } from 'path'
import { ROOM } from '../hub/fit.ts'
import { stateDir } from '../hub/store.ts'

// After a compaction, the end of the conversation word for word: a hub session's thread, a terminal
// session's own, as many of its newest whole messages as fit a hook.
const { session_id } = JSON.parse((await Bun.stdin.text()) || '{}')
const thread = process.env.HEX_THREAD || session_id
if (!thread) process.exit(0)
const hex = join(import.meta.dir, 'hex')
const lead = `Your context was just compacted. These are the conversation's newest messages, word for word, from \`${hex} log\`; \`${hex} log -- '${thread}'\` has any before them, and the summary above has what you did in the turn in progress.`
const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '../hub/cli.ts'), stateDir(), 'log', '--last', '200', '--taken', '--room', String(ROOM - lead.length - 2), '--', thread], { stderr: 'ignore' })
const log = run.stdout.toString().trimEnd()
if (run.exitCode === 0 && log) console.log(`${lead}\n\n${log}`)
