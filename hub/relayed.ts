import { served } from './running.ts'
import { open, stateDir } from './store.ts'

// A hex session's message to a T3 Code thread (t3_thread_send, t3_thread_launch) is kept in hex.db's
// relays: T3 Code records who sent it only as "an agent", and this says which thread did, so the
// voice app's Tasks shows the run it started under that thread.
const from = served()
const at = new Date().toISOString()

type Ran = { threadId: string; runId: string }

// T3 Code answers with the thread and the run the message started or steered, as JSON text in a
// content block or as structured content.
function ran(response: unknown): Ran | undefined {
  if (typeof response === 'string') {
    try {
      return ran(JSON.parse(response))
    } catch {
      return
    }
  }
  if (Array.isArray(response)) return response.map(block => ran(block?.text)).find(Boolean)
  if (!response || typeof response !== 'object') return
  const { threadId, runId, structuredContent } = response as Record<string, unknown>
  return typeof threadId === 'string' && typeof runId === 'string' ? { threadId, runId } : ran(structuredContent)
}

if (from) {
  const run = ran(JSON.parse((await Bun.stdin.text()) || '{}').tool_response)
  if (run) open(stateDir()).relayed(from, run.threadId, run.runId, at)
}
