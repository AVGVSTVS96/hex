import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// T3 Code's own server, which hex calls like T3's app does: over its WebSocket RPC, with a bearer
// token its CLI issues for the call and revokes after.
const HOME = process.env.T3CODE_HOME ?? join(homedir(), '.t3')
const USERDATA = join(HOME, 'userdata')
const SCOPES = ['orchestration:read', 'orchestration:operate']

type Frame = { _tag: string; requestId?: string; exit?: { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: { _tag: string; error?: { message?: string }; defect?: unknown }[] } }

async function cli(...args: string[]) {
  const run = Bun.spawn([join(HOME, 'bin', 't3'), ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(`t3 ${args.slice(0, 3).join(' ')} failed: ${err.trim() || `exit ${code}`}`)
  return out
}

function failure(exit: Extract<NonNullable<Frame['exit']>, { _tag: 'Failure' }>) {
  return exit.cause.map(cause => cause.error?.message ?? String(cause.defect ?? cause._tag)).join('; ')
}

// Runs work with a call(tag, payload) that reaches T3's server, then lets the token go.
export async function withT3<T>(work: (call: (tag: string, payload: object) => Promise<any>) => Promise<T>): Promise<T> {
  const { origin } = JSON.parse(readFileSync(join(USERDATA, 'server-runtime.json'), 'utf8')) as { origin: string }
  const issued = JSON.parse(await cli('auth', 'session', 'issue', ...SCOPES.flatMap(scope => ['--scope', scope]), '--ttl', '5m', '--label', 'hex', '--json')) as { sessionId: string; token: string }
  let ws: WebSocket | undefined
  try {
    const answer = await fetch(`${origin}/api/auth/websocket-ticket`, { method: 'POST', headers: { authorization: `Bearer ${issued.token}` } })
    if (!answer.ok) throw new Error(`T3 Code refused a websocket ticket: HTTP ${answer.status}`)
    const { ticket } = (await answer.json()) as { ticket: string }
    const socket = (ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`))
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    let next = 0
    const lost = new Promise<never>((_, reject) => {
      socket.onerror = () => reject(new Error("T3 Code's server dropped the connection"))
      socket.onclose = () => {
        for (const { reject: drop } of pending.values()) drop(new Error("T3 Code's server closed the connection"))
        reject(new Error("T3 Code's server closed the connection"))
      }
    })
    lost.catch(() => {})
    await Promise.race([new Promise(resolve => (socket.onopen = resolve)), lost])
    socket.onmessage = event => {
      for (const frame of ([] as Frame[]).concat(JSON.parse(String(event.data)))) {
        if (frame._tag === 'Ping') socket.send(JSON.stringify({ _tag: 'Pong' }))
        const waiting = frame._tag === 'Exit' && pending.get(frame.requestId!)
        if (!waiting) continue
        pending.delete(frame.requestId!)
        if (frame.exit!._tag === 'Success') waiting.resolve(frame.exit!.value)
        else waiting.reject(new Error(failure(frame.exit!)))
      }
    }
    const call = (tag: string, payload: object) => {
      const id = String(++next)
      socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    }
    return await work(call)
  } finally {
    ws?.close()
    void cli('auth', 'session', 'revoke', issued.sessionId).catch(error => process.stderr.write(`t3: ${error}\n`))
  }
}

// The T3 project whose folder is root, from T3's own records, read only.
export function projectAt(root: string): string | undefined {
  const file = join(USERDATA, 'statev2.sqlite')
  if (!existsSync(file)) return
  const db = new Database(file, { readonly: true })
  try {
    return db.query<{ id: string }, [string]>('select project_id id from projection_projects where workspace_root = ? and deleted_at is null order by created_at limit 1').get(root)?.id
  } finally {
    db.close()
  }
}

// Whether T3 is restarting this session's turn to steer it, from T3's own records, read only. T3
// steers an ACP agent by cancelling the turn and prompting again with the steer, and ACP has no way
// to tell the agent which, so the cancel alone looks like a Stop. Before it cancels, T3 records the
// run as starting again on a steering_restart attempt, in the run and attempt shapes of its
// contracts. If the read fails, the cancel is a Stop.
export function steering(session: string) {
  const file = join(USERDATA, 'statev2.sqlite')
  if (!existsSync(file)) return false
  const db = new Database(file, { readonly: true })
  try {
    return !!db
      .query(`select 1 from orchestration_v2_projection_runs run
        join orchestration_v2_projection_run_attempts attempt on attempt.attempt_id = json_extract(run.payload_json, '$.activeAttemptId')
        join orchestration_v2_projection_provider_threads thread on thread.provider_thread_id = attempt.provider_thread_id
        where run.status = 'starting' and json_extract(attempt.payload_json, '$.reason') = 'steering_restart' and json_extract(thread.payload_json, '$.nativeThreadRef.nativeId') = ?`)
      .get(session)
  } catch (error) {
    process.stderr.write(`t3: can't read whether T3 is steering ${session}, so its cancel is a Stop: ${error}\n`)
    return false
  } finally {
    db.close()
  }
}

// Who wrote the prompt T3 just sent this session, from T3's own records, read only: the owner, in
// T3 Code's web or mobile app; T3 itself (a PR watch, a delegated task's result, a restart); or
// another agent through T3's tools, which is hex. ACP's prompt says nothing of who wrote it, so as
// with steering() only T3's records can tell. A prompt T3 hasn't recorded, or a read that fails, is
// the owner's, as every T3 prompt was before hex kept authors.
const AUTHORS: Record<string, string> = { 'user/web': 'owner', 'user/mobile': 'owner', 'agent/mcp': 'prompt', 'user/server': 'prompt', 'agent/server': 't3', 'agent/provider': 't3' }
export function promptedBy(session: string, asked: string): string {
  const file = join(USERDATA, 'statev2.sqlite')
  if (!existsSync(file) || !asked) return 'owner'
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true })
    const recent = db
      .query<{ by: string; text: string | null }, [string]>(`select json_extract(message.payload_json, '$.createdBy') || '/' || json_extract(message.payload_json, '$.creationSource') as by, json_extract(message.payload_json, '$.text') as text
        from orchestration_v2_projection_messages message
        join orchestration_v2_projection_provider_threads thread on thread.thread_id = message.thread_id
        where json_extract(thread.payload_json, '$.nativeThreadRef.nativeId') = ? and message.role = 'user' order by message.created_at desc limit 5`)
      .all(session)
    const by = recent.find(prompt => prompt.text?.trim() === asked.trim())?.by
    return (by && AUTHORS[by]) ?? (by?.startsWith('system/') ? 't3' : 'owner')
  } catch (error) {
    process.stderr.write(`t3: can't read who wrote ${session}'s prompt, so it's the owner's: ${error}\n`)
    return 'owner'
  } finally {
    db?.close()
  }
}

// T3_APP_SCHEME is the T3 Code app's URL scheme: t3code, t3code-preview or t3code-dev.
export function linkTo(thread: string) {
  const environment = readFileSync(join(USERDATA, 'environment-id'), 'utf8').trim()
  return `${process.env.T3_APP_SCHEME || 't3code'}://threads/${environment}/${encodeURIComponent(thread)}`
}
