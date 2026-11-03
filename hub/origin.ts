import { join } from 'path'
import { served } from './running.ts'
import { open, spoken, stateDir, type Store } from './store.ts'

// Where work handed to another agent came from: the owner's conversation, and their newest words in
// it that the session had taken by `before`, both by the commands that print them word for word: an
// edit is named by the message it edits, which `hex message` prints with its newest words. A
// reaction, a deletion, a vote taken off or an answer taken back says no words. Every handoff carries
// it, whatever the brief says, so the agent can read the owner's own words instead of only a retelling.
export function origin(store: Store, owner: string | undefined, before?: string, hex = join(import.meta.dir, '..')): string | undefined {
  if (!owner) return
  const thread = store.key(owner)
  const names = store.names()
  if (!(thread in names)) return
  const said = store.said(thread, -1, before).filter(row => row.taken && (!before || row.taken.at < before) && spoken(row) && !['reaction', 'deleted', 'vote_removed', 'took_back'].some(wordless => row.meta?.[wordless])).at(-1)
  const message = said?.meta?.edited ? said.key.slice(0, said.key.lastIndexOf(':') + 1) + said.meta.message_id : said?.key
  const name = names[thread]
  const log = `\`${hex}/bin/hex log --last 100 -- '${thread}'\` prints its newest 100 messages (without --last, all of it)`
  return `This work comes from my conversation${name ? ` in ${name}` : ''}: ${message ? `${log}, and \`${hex}/bin/hex message ${message}\` my newest message there, word for word.` : `${log}.`}`
}

// A thread's session's subagents get it as they start, from its thread, whatever job variables it
// inherited. A job's session and its subagents get it from the conversation that started the job, as
// it was then (HEX_FROM and HEX_FROM_AT, from bin/job), and nothing when no conversation did.
if (import.meta.main) {
  try {
    const { hook_event_name: event } = JSON.parse((await Bun.stdin.text()) || '{}')
    const thread = served({ HEX_CHANNEL: process.env.HEX_CHANNEL, HEX_THREAD: process.env.HEX_THREAD })
    const owner = thread ?? process.env.HEX_FROM
    const line = owner && (event === 'SubagentStart' || !thread) && origin(open(stateDir()), owner, thread ? undefined : process.env.HEX_FROM_AT)
    if (line) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }))
  } catch (error) {
    console.error(`hex couldn't say where this work came from: ${error}`)
  }
}
