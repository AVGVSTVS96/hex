#!/usr/bin/env bun
// away <machine> <environment> <name> <claude args...>: runs an agent job as a T3 Code thread on another machine,
// through this machine's T3 Code and its link to that one, so it starts the way T3 starts Claude Code, and follows it
// the way `t3 thread start --wait` does: until its run ends and every background task it started has woken it with
// its result, then prints its answer; it stops the thread if the job stops. Having started nothing, it exits 76 when the job can't run there (claude flags a thread has no place for, no
// Claude there, a link that's gone) and 77 when T3 Code, here or there, doesn't answer; bin/place then tries the next
// machine.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'

const [machine, environmentId, name, ...args] = process.argv.slice(2) as [string, string, string, ...string[]]
const home = join(import.meta.dir, '../..')
const [ELSEWHERE, UNREACHABLE] = [76, 77]
const quit = (code: number, why: string): never => {
  console.error(`away: ${name} can't run on ${machine}: ${why}`)
  process.exit(code)
}

// The claude flags a thread has a place for; a job with any other runs where its flags mean something.
let model: string | undefined
let effort: string | undefined
const words: string[] = []
for (let at = 0; at < args.length; at++) {
  const arg = args[at]!
  if (arg === '-p' || arg === '--print') continue
  else if (arg === '--model') model = args[++at]
  else if (arg === '--effort') effort = args[++at]
  else if (arg === '--session-id') at++
  else if (/^--?[A-Za-z][\w-]*(=.*)?$/.test(arg)) quit(ELSEWHERE, `${arg} has no place in a T3 Code thread`)
  else words.push(arg)
}
const piped = process.stdin.isTTY ? '' : (await Bun.stdin.text()).trim()
const asked = [words.join(' '), piped].filter(Boolean).join('\n\n')
if (!asked) quit(ELSEWHERE, 'the job has no prompt')

function parse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {}
}
// T3's own split (RemoteDelegation): a revoked link or a thread or run that's gone is final. A fault on this machine is its own (Local), so it isn't charged to the other one. The other machine
// asleep, a dropped route or T3 Code restarting is retried.
const FINAL = ['capability_denied', 'thread_not_found', 'run_not_found']
class Final extends Error {}
class Local extends Error {}
const here = (why: string) => new Local(`T3 Code on ${hostname()}, this machine: ${why}`)

// This machine's T3 Code /mcp, signed in once; its MCP tools are the only calls T3 forwards over a link. A refused
// token is renewed once. Signing in runs beside signals, so a stop is never held up behind it.
type Headers = Record<string, string>
let headers: Promise<Headers> | undefined
async function signIn(refused?: string): Promise<Headers> {
  const env = { ...process.env, ...(refused && { T3_REFUSED: refused }) }
  const helper = Bun.spawn([join(import.meta.dir, 't3-mcp-headers'), ...(refused ? ['--refresh'] : [])], { cwd: home, env, stdout: 'pipe', stderr: 'pipe', timeout: 180_000, killSignal: 'SIGKILL' })
  const [out, err, code] = await Promise.all([new Response(helper.stdout).text(), new Response(helper.stderr).text(), helper.exited])
  const signed = parse(out)
  // Retried like a call that didn't answer: a sign-in can wait on another job's, or on T3 Code restarting.
  if (code !== 0 || typeof signed?.Authorization !== 'string') throw new Error(`T3 Code on ${hostname()}, this machine: couldn't sign in: ${err.trim() || 'no sign-in printed'}`)
  return { ...signed, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
}
const signedIn = (refused?: string) =>
  (headers = signIn(refused).catch(error => {
    headers = undefined
    throw error
  }))
const url = (() => {
  try {
    return `http://127.0.0.1:${JSON.parse(readFileSync(join(homedir(), '.t3/userdata/server-runtime.json'), 'utf8')).port}/mcp`
  } catch {
    quit(UNREACHABLE, here("it isn't running (no ~/.t3/userdata/server-runtime.json)").message)
  }
})()!
// The SDK owns the MCP session, request ids and response streams. The fetch adapter only
// supplies this machine's pairing credential, renewing a refused token once.
let client: Client | undefined
let transport: StreamableHTTPClientTransport | undefined
let opening: Promise<Client> | undefined
const authenticated: typeof fetch = async (input, init) => {
  const using = headers ?? signedIn()
  let used = await using
  const send = () => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...used }, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(120_000)]) })
  let answer = await send()
  if (answer.status === 401) {
    await answer.body?.cancel()
    used = await (headers === using ? signedIn(used.Authorization!.replace(/^Bearer /, '')) : headers ?? signedIn())
    answer = await send()
  }
  if (answer.status >= 400 && answer.status < 500 && ![404, 405, 408, 429].includes(answer.status)) throw here(`HTTP ${answer.status} ${await answer.text()}`)
  return answer
}
const open = () =>
  (opening ??= (async () => {
    await client?.close().catch(() => {})
    client = new Client({ name: 'hex-away', version: '1' })
    transport = new StreamableHTTPClientTransport(new URL(url), { fetch: authenticated })
    await client.connect(transport, { timeout: 120_000 })
    return client
  })().catch(error => {
    opening = undefined
    throw error
  }))
async function call(tool: string, input: Record<string, unknown>, { patience = 120_000 }: { patience?: number } = {}): Promise<any> {
  const connected = await open()
  const result = await connected.callTool({ name: tool, arguments: { environmentId, ...input } }, undefined, { timeout: patience })
  const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text ?? ''
  const code = parse(text)?.code
  if (result.isError) throw Object.assign(FINAL.includes(code) ? new Final(`${tool}: ${text}`) : new Error(`${tool}: ${text}`), { code })
  return result.structuredContent ?? parse(text)
}

let threadId: string | undefined
let tried = false
let inflight: Promise<any> | undefined
let stopping = false
let halting: Promise<void> | undefined
const invocation = process.env.INVOCATION_ID ?? String(process.pid)
const requestId = `hex-job-${name}-${machine}-${invocation}`
// Its own title, so a thread whose launch answer was lost is found by it, whatever sign-in sent the launch.
const title = `${name} · ${invocation.slice(0, 8)}`
async function find(patience?: number): Promise<{ threadId: string; runId?: string; link: string } | undefined> {
  for (let cursor: number | undefined, pages = 0; pages < 5; pages++) {
    const page = await call('t3_thread_list', { allProjects: true, titleContains: title, limit: 100, cursor }, { patience })
    const thread = (page.threads as { threadId: string; title: string; latestRunId?: string; link: string }[]).find(thread => thread.title === title)
    if (thread) return { threadId: thread.threadId, runId: thread.latestRunId, link: thread.link }
    if ((cursor = page.nextCursor ?? undefined) === undefined) return
  }
}
// What a job's owner needs to hear while it runs, beyond its output.
const tell = (said: string) =>
  process.env.HEX_OWNER ? Bun.spawn(['bun', join(import.meta.dir, 'job'), '--tell', name.split('/').pop()!, process.env.HEX_OWNER, said], { stdout: 'ignore', stderr: 'inherit' }).exited : undefined
// Stopping the thread, once: one whose launch was tried is the launch's answer or found by its title, then interrupted. All of it in 70 s,
// inside the 90 s bin/job gives an agent unit to stop.
const stopThread = (reason: string) => (halting ??= halt(reason))
async function halt(reason: string) {
  let why = 'it gave no answer in 70 s'
  const stopped = (async () => {
    for (let wait = 1_000; ; wait = Math.min(wait * 2, 10_000)) {
      try {
        if (!threadId && inflight) threadId = (await Promise.race([inflight.catch(() => undefined), Bun.sleep(20_000)]))?.threadId
        if (!threadId && tried) threadId = (await find(30_000))?.threadId
        if (!threadId) return true
        await call('t3_thread_interrupt', { threadId, stop: true, reason }, { patience: 30_000 })
        // T3 records the interrupt before its provider acts on it, so the stop counts once the run has ended.
        if ((await call('t3_thread_wait', { threadId, timeoutMs: 15_000 }, { patience: 30_000 })).timedOut) throw new Error('its run was still going after the interrupt')
        return true
      } catch (error) {
        why = (error as Error).message
        if ((error as { code?: string }).code === 'thread_not_found') return true
        if (error instanceof Final) return false
        opening = undefined
        await Bun.sleep(wait)
      }
    }
  })()
  if (await Promise.race([stopped, Bun.sleep(70_000).then(() => false)])) return
  const where = threadId ? `its T3 Code thread <t3-thread://v2/${environmentId}/${threadId}>` : `a T3 Code thread titled "${title}"`
  const said = `couldn't stop on ${machine} (${why}): ${where} may still be running there. Stop it in T3 Code on ${machine}.`
  console.log(`${name} ${said}`)
  await Promise.race([tell(said), Bun.sleep(5_000)])
}
// Every way out after a stop waits for it, so the thread is stopped before the job ends, and closes its MCP session.
async function exit(code: number): Promise<never> {
  if (stopping) await halting
  await Promise.race([(async () => { await transport?.terminateSession().catch(() => {}); await client?.close().catch(() => {}) })(), Bun.sleep(2_000)])
  process.exit(stopping ? 143 : code)
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void stopThread(`hex stopped the job ${name}`)
    void exit(143)
  })
// A call is retried with backoff until it's final, patience runs out or the job stops. A running thread that can't
// be reached for 10 minutes is told to its owner once, as the job keeps trying.
let told = false
async function persist<T>(what: () => Promise<T>, patience = Infinity): Promise<T> {
  const since = Date.now()
  const until = since + patience
  for (let wait = 5_000; ; wait = Math.min(wait * 2, 120_000)) {
    try {
      return await what()
    } catch (error) {
      if (stopping) return exit(143)
      if (error instanceof Final || error instanceof Local || Date.now() + wait > until) throw error
      console.error(`away: ${(error as Error).message}; trying again in ${wait / 1000} s`)
      if (threadId && !told && Date.now() - since > 600_000) {
        told = true
        void tell(`can't reach its T3 Code thread <t3-thread://v2/${environmentId}/${threadId}> on ${machine} for 10 minutes (${(error as Error).message}). It keeps trying.`)
      }
      opening = undefined
      await Bun.sleep(wait)
      if (stopping) return exit(143)
    }
  }
}

// This machine's sign-in first, so its fault is named as its own at once.
await signedIn().catch((error: Error) => quit(UNREACHABLE, error.message))
// The first forwarded call starts nothing, so a machine that doesn't answer it in 5 minutes is left for the next one,
// and one this machine has no link to (T3's invalid_request: unknown_link) is passed over.
const capabilities = () =>
  call('orchestrator_capabilities', {}).catch(error => {
    throw error.code === 'invalid_request' ? new Final(error.message) : error
  })
const offered = await persist(capabilities, 300_000).catch((error: Error) => quit(error instanceof Final ? ELSEWHERE : UNREACHABLE, error.message))
if (stopping) await exit(143)
// A model goes by its alias, like opus, or its id, as that machine's Claude lists it, newest first; with none, the one hex's sessions run.
const configured = (path: string) => {
  try {
    return parse(readFileSync(path, 'utf8'))?.model as string | undefined
  } catch {}
}
const wanted = model ?? configured(join(home, '.claude/settings.json')) ?? configured(join(homedir(), '.claude/settings.json')) ?? 'opus'
const claude = (offered.providers as { providerInstanceId: string; models: { id: string }[] }[]).find(provider => provider.providerInstanceId === 'claudeAgent')
const chosen = claude?.models.find(({ id }) => id === wanted) ?? claude?.models.filter(({ id }) => id.includes(wanted)).sort((a, b) => b.id.localeCompare(a.id))[0]
if (!chosen) quit(ELSEWHERE, claude ? `its Claude has no ${wanted}` : 'its T3 Code has no Claude')

const identity = Bun.spawnSync([join(import.meta.dir, 'identity'), home]).stdout.toString()
const message = `${identity}

You are running on ${machine}, in a T3 Code thread hex started there because ${hostname()}, where hex runs, was short on room. The job was started in ${process.cwd()} on ${hostname()}. Your folder ${home}, the files under it and every other path on ${hostname()} are reached with \`ssh ${userInfo().username}@${hostname()} '<command>'\`, hex's commands included. Work in this machine's own checkouts: clone or pull a repo here, and push what you commit.

${asked}`
if (message.length > 120_000) quit(ELSEWHERE, `its prompt is ${message.length} characters, over the 120,000 a T3 Code thread takes`)

// A launch is retried for half an hour, with one clientRequestId so T3 Code gives back a thread it already started,
// and after a lost answer the thread is looked for by its title first, as T3 Code keys that id to the sign-in that
// sent it. Once one was tried, the job runs there or fails, never moving to another machine where it could run twice.
const launch = () =>
  call('t3_thread_launch', {
    title,
    scratch: true,
    message,
    runtimeMode: 'full-access',
    modelSelection: { provider: 'claudeAgent', model: chosen.id, options: effort ? [{ id: 'effort', value: effort }] : [] },
    clientRequestId: requestId,
  })
const launched = await persist(async () => {
  if (tried) {
    const found = await find()
    // T3 creates a thread before it sends it its first message, so one without a run isn't launched yet.
    if (found && !found.runId) throw new Error(`its thread ${found.link} has no run yet`)
    if (found) return found
  }
  if (stopping) return exit(143)
  tried = true
  inflight = launch()
  try {
    return await inflight
  } finally {
    inflight = undefined
  }
}, 1_800_000).catch(async (error: Error) => {
  console.error(`away: ${name} couldn't start on ${machine}: ${error.message}; stopping any thread it started there`)
  await stopThread(`hex couldn't start the job ${name}`)
  return exit(1)
})
threadId ??= launched.threadId as string
if (stopping) await exit(143)
console.log(`${name} runs on ${machine} as T3 Code thread ${launched.link}`)

// As `t3 thread start --wait` does (T3's cli/thread.ts waitForRun): a run that hasn't ended while its thread has a
// pending request, checked once more, needs an answer a job can't give. With Claude, a pending request holds its turn.
const runId = launched.runId
// A run has ended when its status is final and the wait didn't time out: T3 times out a run a restart cut, final as
// its status reads, while its continuation is pending, and one whose background tasks will still wake the thread.
const FINISHED = ['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']
const ended = ({ status, timedOut }: { status: string; timedOut: boolean }) => FINISHED.includes(status) && !timedOut
async function follow(): Promise<number> {
  const slice = (timeoutMs: number) => persist(() => call('t3_thread_wait', { threadId, runId, timeoutMs, untilDelegatedWorkSettled: true }))
  let waited = await slice(50_000)
  while (!ended(waited)) {
    const { thread } = await persist(() => call('t3_thread_read', { threadId, limit: 1, runLimit: 1 }))
    const pending = thread.pendingRequestCount > 0 || waited.hasPendingQuestion || waited.pendingApproval
    if (pending && !ended((waited = await slice(1)))) {
      const { requestIds } = await call('t3_pending_request', { action: 'list', threadId }).catch(() => ({}))
      const read = requestIds?.length ? await call('t3_pending_request', { action: 'read', threadId, requestId: requestIds[0] }).catch(() => undefined) : undefined
      await stopThread(`the job ${name} has nobody to answer`)
      const question = (read?.questions as { question: string }[] | undefined)?.map(({ question }) => question).join(' ')
      console.log(`${name} stopped on ${machine} at a question, which a job can't answer: ${question ?? `see ${launched.link}`}`)
      return 1
    }
    // A wait that comes back early without an end gets a pause, so the two machines aren't asked in a tight loop.
    if (!waited.timedOut) await Bun.sleep(5_000)
    if (!ended(waited)) waited = await slice(50_000)
  }
  if (stopping) return exit(143)
  let last: { text: string } | undefined
  for (let after: number | undefined, more = true; more; ) {
    const page = await persist(() => call('t3_thread_read', { threadId, view: 'messages', limit: 100, maxCharsPerItem: 50_000, afterPosition: after }))
    last = (page.items as { type: string; text: string }[]).filter(item => item.type === 'assistant_message').at(-1) ?? last
    ;[after, more] = [page.nextPosition, page.hasMore]
  }
  console.log(last?.text ?? `${name} ended on ${machine} with no answer`)
  return (waited.resultRun ?? waited).status === 'completed' ? 0 : 1
}
// A thread this job can no longer follow is stopped, so nothing runs there unwatched.
const code = await follow().catch(async (error: Error) => {
  console.error(`away: ${error.message}; stopping the thread`)
  await stopThread(`hex lost track of the job ${name}`)
  return 1
})
await exit(code)
