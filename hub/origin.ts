import { join } from 'path'
import { served } from './running.ts'
import { open, stateDir, type Store } from './store.ts'

// Where work handed to another agent came from: the owner's conversation, and their newest message in
// it, both by the commands that print them word for word. Every handoff carries it, whatever the
// brief says, so the agent can read the owner's own words instead of only a retelling of them.
export function origin(store: Store, owner: string | undefined, hex = join(import.meta.dir, '..')): string | undefined {
  if (!owner) return
  const thread = store.key(owner)
  const said = store.said(thread).filter(row => row.author === 'owner').at(-1)
  if (!said) return
  const name = store.names()[thread]
  return `This work comes from my conversation${name ? ` in ${name}` : ''}: \`${hex}/bin/hex log -- '${thread}'\` prints all of it, and \`${hex}/bin/hex message ${said.key}\` my newest message there, word for word.`
}

// A subagent gets it as it starts, and so does a job's session (hex's own threads are the conversation).
if (import.meta.main) {
  const { hook_event_name: event } = JSON.parse(await Bun.stdin.text())
  const line = (event === 'SubagentStart' || process.env.HEX_OWNER) && origin(open(stateDir()), served())
  if (line) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }))
}
