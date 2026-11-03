import { join } from 'path'
import { served } from './running.ts'
import { open, spoken, stateDir, type Store } from './store.ts'

// Where work handed to another agent came from: the owner's conversation, and their newest words in
// it that the session has taken, both by the commands that print them word for word. A reaction, a
// deletion, a vote taken off or an answer taken back says no words; when hex's own prompt (a schedule,
// a job's end) came after them, the work isn't theirs to point at. Every handoff carries it, whatever
// the brief says, so the agent can read the owner's own words instead of only a retelling of them.
export function origin(store: Store, owner: string | undefined, hex = join(import.meta.dir, '..')): string | undefined {
  if (!owner) return
  const thread = store.key(owner)
  const names = store.names()
  if (!(thread in names)) return
  const last = store.said(thread).filter(row => row.taken && (row.author === 'prompt' || (spoken(row) && !['reaction', 'deleted', 'vote_removed', 'took_back'].some(wordless => row.meta?.[wordless])))).at(-1)
  const said = last?.author === 'prompt' ? undefined : last
  const name = names[thread]
  const log = `\`${hex}/bin/hex log --last 100 -- '${thread}'\` prints its newest 100 messages (without --last, all of it)`
  return `This work comes from my conversation${name ? ` in ${name}` : ''}: ${said ? `${log}, and \`${hex}/bin/hex message ${said.key}\` my newest message there, word for word.` : `${log}.`}`
}

// A subagent gets it as it starts, and so does a job's session (hex's own threads are the conversation),
// from the conversation that started the job when that isn't the thread it reports to. A thread's own
// session goes by its thread, whatever job variables it inherited.
if (import.meta.main) {
  try {
    const { hook_event_name: event } = JSON.parse((await Bun.stdin.text()) || '{}')
    const job = !(process.env.HEX_CHANNEL && process.env.HEX_THREAD)
    const owner = (job && process.env.HEX_FROM) || served()
    const line = owner && (event === 'SubagentStart' || (job && process.env.HEX_OWNER)) && origin(open(stateDir()), owner)
    if (line) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }))
  } catch (error) {
    console.error(`hex couldn't say where this work came from: ${error}`)
  }
}
