import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join } from 'path'
import { backOf, firstLine, followTranscript, generalOf, itemStep, nameOf, past, sizeOf, stepOf, unmark, type Did, type Update } from './activity.ts'
import { busy, CLAUDE, running, ownership, type Session } from '../../hub/running.ts'
import { Changes } from './changes.ts'
import { HANDED, Links, type Delegation } from './links.ts'
import { open, type Thread as Stored } from '../../hub/store.ts'

export type State = 'working' | 'needs' | 'done' | 'failed' | 'idle'
export type Step = Did & { at: string; end?: string }
export type Planned = { text: string; state: 'done' | 'running' | 'pending' }
export type Agent = {
  id: string
  label: string
  state: 'working' | 'done' | 'failed' | 'stopped'
  via: 'claude' | 't3'
  who?: string
  since?: string
  end?: string
  line?: string
  result?: string
  link?: string
  steps: Step[]
}
export type Moment = { at: string; state: State; text: string }
export type Turn = { at: string; state: State }
export type Row = Omit<Run, 'needs' | 'lately' | 'steps' | 'plan' | 'agents'> & { agents: Omit<Agent, 'steps' | 'result'>[] }
export type Summary = { needs: number; working: number }
// A thread off the board, as its page shows it: what hex.db and its own last job records say.
export type Page = Pick<Run, 'id' | 'app' | 'thread' | 'name' | 'where' | 'place'> & Partial<Pick<Run, 'at' | 'line' | 'link'>>
export type Run = {
  id: string
  app: string
  thread: string
  name: string
  where: string
  place: string
  state: State
  running: boolean
  line: string
  needs?: string
  since: string
  at: string
  agents: Agent[]
  steps: Step[]
  plan: Planned[]
  lately: Moment[]
  track: Turn[]
  link?: string
}

type Thread = { app: string; id: string; name: string; session?: string; cwd?: string; link?: string; general?: true }
type Job = {
  state?: string
  detail?: string
  needs?: string
  cwd?: string
  updatedAt?: string
  fan?: Fan[]
}
type Fan = { id: string; kind: string; label: string; startedAt?: number; doneAt?: number }
type Entry = { at: string; state: string; detail?: string; text?: string }
type Told = { state: Agent['state']; result?: string }
type Stretch = Pick<Run, 'steps' | 'plan' | 'agents'>
type Follower = { stop: () => void; keep: number; steps: Step[]; plan: Planned[]; model?: string; type?: string; told: Map<string, Told>; last?: string; said: Step[] }
// A heartbeat's turn, as hex.db keeps it.
type Beat = { began: string; until?: string; after?: string }

const TAIL = 256 * 1024
// When a step's transcript line was written, as hex's hook stamps a heartbeat: a tool call shows
// from the line before it, which can be the prompt that came ahead of the hook.
const written = new WeakMap<Step, string>()
const LATELY = 5
const STEPS = 24
const AGENT_STEPS = 12
const RESULT = 600
const KEEP = 7 * 24 * 60 * 60_000
const TRACK = 7 * 24 * 60 * 60_000
const FINE = 60 * 60_000
const GRAIN = 50
const SAVE = 2000
const ORDER: State[] = ['needs', 'working', 'done', 'failed', 'idle']
const STATES: Record<string, State> = { working: 'working', blocked: 'needs', done: 'done', failed: 'failed' }
const PLANNED: Record<string, Planned['state']> = { completed: 'done', in_progress: 'running', pending: 'pending' }
const APPS: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', buzz: 'Buzz', t3: 'T3 Code', voice: 'Voice', claude: 'Claude Code' }
const WORK = new Set(['agent', 'workflow'])
const RUNS = new Set([...WORK, 'shell', 'monitor'])
const TOLD: Record<string, Agent['state']> = { completed: 'done', failed: 'failed' }

// Every hex thread as a run, from the records Claude Code already keeps (the same ones
// `claude agents --json` prints): each session's job state and timeline, which sessions are
// running, hex.db's open threads for their names and where their apps open them, and `links.ts` for T3 Code's side.
// A session a thread's session started (a topic's `claude -p` build, found by its environment or
// its process tree), a job a thread owns (bin/job), or a T3 Code thread's session below one the
// thread handed off, counts toward it as one of its agents. So does each T3 Code thread a hex T3
// thread handed work to, which shows only under it. A running session that works for no thread
// (hex's own check, its memory agent, a terminal) isn't on the board; one whose thread is gone is
// a run of its own while it works. It wakes when hex.db's threads or one of those files
// (or T3 Code's database) changes, follows a working thread's transcript for its newest steps, and
// bumps a version on any change.
// The counts behind the app's Tasks button keep their own version, so it hears only when one moves.
export class Board extends Changes {
  runs: Run[] = []
  summary: Summary = { needs: 0, working: 0 }
  counts = new Changes()
  private threads: Thread[] = []
  private links: Links
  private jobs = new Map<string, { job?: Job; timeline: Entry[] }>()
  private sessions = new Map<string, Session>()
  private watchers = new Map<string, FSWatcher>()
  private followers = new Map<string, Follower>()
  private stretches = new Map<string, Stretch>()
  private pending?: ReturnType<typeof setTimeout>
  private stale = { threads: true, sessions: true }
  private owners = new Map<string, string>()
  private handed = new Set<string>()
  private tops: Session[] = []
  private stops: (() => void)[] = []
  private tracks: Record<string, Turn[]>
  private saving?: ReturnType<typeof setTimeout>
  private beaten = ''
  private beats = new Map<string, Beat[]>()

  constructor(
    private state: string,
    private hexDir: string,
    private claude = CLAUDE,
    t3?: string,
  ) {
    super()
    this.tracks = readJson(join(state, 'voice', 'tracks.json')) ?? {}
    this.links = new Links(state, () => this.schedule(), t3)
    this.stops.push(
      open(state).watch(() => {
        if (JSON.stringify(this.stored()) !== JSON.stringify(this.threads)) this.mark('threads')
        const beaten = open(state).beaten()
        if (beaten !== this.beaten) this.schedule()
        this.beaten = beaten
      }),
    )
    this.stops.push(watchDir(join(claude, 'sessions'), () => this.mark('sessions')))
    this.stops.push(watchDir(join(claude, 'jobs'), file => this.jobChanged(file, true)))
    this.build()
  }

  get(id: string) {
    return this.runs.find(run => run.id === id)
  }

  // Any thread hex.db has had: its run while it's on the board, else a read-only page from what was
  // last kept for it, read fresh. A session another open thread holds now says nothing of this one,
  // a question it was blocked on is no line, and a thread that shows only under another has no page.
  find(id: string): Run | Page | undefined {
    const kept = this.get(id)
    if (kept) return kept
    const all = open(this.state).threads()
    const row = all.find(({ app, thread }) => APPS[app] && `${app}:${thread}` === id)
    if (!row || this.links.delegated(row.app, row.thread)) return
    const thread = threadOf(row, generalOf(all))
    const own = row.session && !all.some(one => one !== row && one.open && one.session === row.session) ? row.session : undefined
    const job: Job | undefined = own && readJson(join(this.claude, 'jobs', short(own), 'state.json'))
    const at = job?.updatedAt ?? this.tracks[id]?.at(-1)?.at
    const line = job?.detail && job.state !== 'stopped' && job.state !== 'blocked' ? oneLine(plain(job.detail)) : undefined
    return { id, app: thread.app, thread: thread.id, name: thread.name, where: where(thread), place: this.place(thread), ...(at && { at }), ...(line && { line }), ...(thread.link && { link: thread.link }) }
  }

  // The Claude Code session a run's thread runs in, whose log holds its chat.
  session(id: string) {
    return [...this.threads, ...this.loose()].find(thread => `${thread.app}:${thread.id}` === id)?.session
  }

  rows(): Row[] {
    return this.runs.map(({ needs, lately, steps, plan, agents, ...row }) => ({ ...row, agents: agents.map(({ steps, result, ...agent }) => agent) }))
  }

  close() {
    clearTimeout(this.pending)
    if (this.saving) this.saveTracks()
    this.links.close()
    for (const stop of this.stops) stop()
    for (const watcher of this.watchers.values()) watcher.close()
    for (const follower of this.followers.values()) follower.stop()
  }

  private mark(what: 'threads' | 'sessions') {
    this.stale[what] = true
    this.schedule()
  }

  // A renewed session gets a new job folder, and a watch on the old one hears nothing more.
  private jobChanged(short: string | null, folder = false) {
    if (!short || !this.wanted().has(short)) return
    if (folder) this.unwatchJob(short)
    this.jobs.delete(short)
    this.watchJob(short)
    this.schedule()
  }

  // A burst of writes (a state, its timeline, a session file) lands as one rebuild.
  private schedule() {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.build(), 30)
  }

  private build() {
    if (this.stale.threads) this.readThreads()
    if (this.stale.sessions) this.readSessions()
    this.own()
    this.watchJobs()
    this.stale = { threads: false, sessions: false }
    this.beats = open(this.state).everyBeat()
    const since = new Date(Date.now() - KEEP).toISOString()
    const threads = this.threads
      .filter(thread => !this.links.delegated(thread.app, thread.id))
      .map(thread => this.run(thread))
      .filter(run => run.state === 'needs' || run.state === 'working' || run.at > since)
    const runs = [...threads, ...this.loose().map(thread => this.run(thread)).filter(run => run.state === 'working')]
    this.follow(runs)
    for (const run of runs) this.keep(run)
    runs.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.at.localeCompare(a.at))
    if (JSON.stringify(runs) === JSON.stringify(this.runs)) return
    this.runs = runs
    this.changed()
    const summary = { needs: count(runs, 'needs'), working: count(runs, 'working') }
    if (summary.needs === this.summary.needs && summary.working === this.summary.working) return
    this.summary = summary
    this.counts.changed()
  }

  // A working thread's stretch of work is kept, so once it stops it still shows its last steps,
  // plan and agents, until it works again: a step still running then just loses its state, and an
  // agent still working says what T3 Code says of it now.
  private keep(run: Run) {
    const stretch = this.stretches.get(run.id)
    if (run.state === 'working') this.stretches.set(run.id, { steps: run.steps, plan: run.plan, agents: run.agents })
    if (run.state === 'working' || !stretch) return
    const thread = this.threads.find(thread => `${thread.app}:${thread.id}` === run.id)
    const handed = this.links.delegations(run.app, run.thread)
    Object.assign(run, {
      steps: settled(stretch.steps),
      plan: stretch.plan,
      agents: stretch.agents.map(agent => {
        const one = agent.state === 'working' && handed.find(one => one.id === agent.id)
        return one && thread ? this.delegation(keyOf(thread), one, settled(agent.steps)) : { ...agent, steps: settled(agent.steps) }
      }),
    })
  }

  private readThreads() {
    this.threads = this.stored()
  }

  private stored(): Thread[] {
    const all = open(this.state).threads()
    const general = generalOf(all)
    return all.filter(({ app, open }) => open && APPS[app]).map(row => threadOf(row, general))
  }

  // What a thread's app calls it: General or the DM, T3 Code's own title, else its name.
  private place(thread: Thread) {
    const app = where(thread)
    return app === 'General' || app === 'DM' ? app : (this.links.title(thread.app, thread.id) ?? thread.name)
  }

  // Each thread's session, as the <app>:<key> of the thread it serves.
  private held() {
    return new Map(this.threads.flatMap(thread => (thread.session ? [[thread.session, `${thread.app}:${thread.id}`] as [string, string]] : [])))
  }

  // The run each running session's work counts toward: the thread it works for (serving), with a T3
  // Code thread's session counted toward the hex thread that last handed work to it, or to one above
  // it; the sessions of T3 Code threads handed off themselves, which show as those delegations; and
  // a run of its own (tops) for each session that works for a thread that isn't on the board
  // (closed, or shown under another thread), which no thread holds and no such session launched;
  // what it launched counts toward it.
  private own() {
    // What a hex T3 thread shown under another launched counts toward that one.
    const shownAt = (thread: string, seen = new Set<string>()): string => {
      const under = this.links.under(thread.slice(0, thread.indexOf(':')), thread.slice(thread.indexOf(':') + 1))
      return under && !seen.has(under) ? shownAt(under, seen.add(thread)) : thread
    }
    const held = this.held()
    const known = new Map(held)
    this.handed = new Set()
    for (const id of this.sessions.keys()) {
      const owner = !known.has(id) && this.links.owner(id)
      if (!owner) continue
      known.set(id, owner.thread)
      if (owner.handed && shownAt(owner.thread) === owner.thread) this.handed.add(id)
    }
    const resolved = new Map([...this.sessions.values()].map(session => [session.id, ownership(session, held, this.sessions, { owners: known, boundary: id => this.links.runs(id), display: shownAt })]))
    const shown = new Set(this.threads.filter(thread => !this.links.delegated(thread.app, thread.id)).map(thread => `${thread.app}:${thread.id}`))
    this.owners = new Map([...resolved].flatMap(([id, result]) => result.thread ? [[id, result.thread] as [string, string]] : []))
    this.tops = []
    for (const session of this.sessions.values()) {
      const { thread: owner, top: run } = resolved.get(session.id)!
      if (!owner || shown.has(owner) || held.has(session.id)) continue
      if (run.id === session.id) this.tops.push(session)
      else this.owners.set(session.id, `claude:${short(run.id)}`)
    }
  }

  // The runs of their own, each named as Claude Code named its session.
  private loose(): Thread[] {
    return this.tops.map(session => ({ app: 'claude', id: short(session.id), name: session.name ?? short(session.id), session: session.id, cwd: session.cwd }))
  }

  // The busy sessions whose work counts toward a run, other than its own and a T3 Code delegation's.
  private started(thread: Thread) {
    const key = `${thread.app}:${thread.id}`
    return [...this.sessions.values()].filter(session => session.id !== thread.session && busy(session) && this.owners.get(session.id) === key && !this.handed.has(session.id))
  }

  private wanted() {
    return new Set([...this.threads, ...this.loose()].flatMap(thread => (thread.session ? [short(thread.session)] : [])))
  }

  private watchJobs() {
    const wanted = this.wanted()
    for (const id of this.watchers.keys()) if (!wanted.has(id)) this.unwatchJob(id)
    for (const id of this.jobs.keys()) if (!wanted.has(id)) this.jobs.delete(id)
    for (const id of wanted) this.watchJob(id)
  }

  private watchJob(id: string) {
    if (this.watchers.has(id)) return
    try {
      this.watchers.set(id, watch(join(this.claude, 'jobs', id), () => this.jobChanged(id)))
    } catch {}
  }

  private unwatchJob(id: string) {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
  }

  private readSessions() {
    this.sessions = running(open(this.state), this.claude)
  }

  private job(session: string) {
    const id = short(session)
    let cached = this.jobs.get(id)
    if (!cached) {
      const dir = join(this.claude, 'jobs', id)
      cached = { job: readJson(join(dir, 'state.json')), timeline: tail(join(dir, 'timeline.jsonl')) }
      this.jobs.set(id, cached)
    }
    return cached
  }

  private run(thread: Thread): Run {
    let { job, timeline } = thread.session ? this.job(thread.session) : { job: undefined, timeline: [] }
    const session = thread.session ? this.sessions.get(thread.session) : undefined
    const started = this.started(thread)
    const handed = this.links.delegations(thread.app, thread.id)
    const out = handed.filter(one => !HANDED[one.status])
    const beats = (thread.session && this.beats.get(thread.session)) || []
    const beat = this.beat(thread, beats, session)
    const earlier = beat !== undefined && !!job?.fan?.some(fan => RUNS.has(fan.kind) && !fan.doneAt && (fan.startedAt ?? 0) < beat)
    if (beat !== undefined && job?.state !== 'blocked') ({ job, timeline } = before(job, timeline, beat, earlier))
    const beating = beat !== undefined && !earlier
    const outside = (at: string) => !beats.some(beat => at >= beat.began && (!beat.until || at < beat.until))
    const ours = (step: Step) => outside(written.get(step) ?? step.at)
    const known = job?.state ? STATES[job.state] : undefined
    const live = (busy(session) && !beating) || started.length > 0 || out.length > 0
    let state: State = live ? 'working' : (known ?? 'idle')
    if (!live && ((state === 'working' && !session) || job?.detail?.startsWith('(idle'))) state = 'idle'
    const lately = timeline
      .filter(entry => entry.text && entry.detail && outside(entry.at))
      .slice(-LATELY)
      .reverse()
      .map(entry => ({ at: entry.at, state: STATES[entry.state] ?? 'idle', text: plain(entry.detail!) }))
    const last = Math.max(session ? (session.updated ?? session.started) : 0, ...started.map(one => one.updated ?? one.started), ...out.map(one => (one.since ? Date.parse(one.since) : 0)))
    const at = job?.updatedAt ?? timeline.at(-1)?.at ?? new Date(live ? last : 0).toISOString()
    const needs = state === 'needs' ? plain(job?.needs ?? job?.detail ?? '') || undefined : undefined
    const detail = job?.state === 'stopped' ? undefined : job?.detail && plain(job.detail)
    const began = Math.min(...started.map(one => one.updated ?? one.started), ...out.map(one => (one.since ? Date.parse(one.since) : Date.now())), busy(session) ? (session!.updated ?? session!.started) : Infinity)
    const since =
      state === 'working' && known !== 'working' ? new Date(began).toISOString() : state === 'working' || state === 'needs' ? (streak(timeline, job?.state) ?? at) : at
    const { link } = thread
    const key = keyOf(thread)
    const steps = state === 'working' ? this.steps(key).filter(ours) : []
    const plan = state === 'working' ? (this.followers.get(key)?.plan ?? []) : []
    const said = state === 'working' ? this.followers.get(key)?.said.findLast(step => step.at >= since && ours(step)) : undefined
    const shown = detail && (shownSince(timeline, detail) ?? at)
    const summary = detail && shown && outside(shown) && !tooled(detail, this.followers.get(key)?.steps ?? []) ? detail : undefined
    const line = (said && (!summary || said.at >= shown!) ? said.text : undefined) || needs || summary || (state === 'working' ? '' : lately[0]?.text) || ''
    const agents = (
      state === 'working'
        ? [
            ...(job?.fan ?? []).filter(fan => WORK.has(fan.kind) && (!fan.doneAt || fan.doneAt >= Date.parse(since)) && !(beat !== undefined && (fan.startedAt ?? 0) >= beat)).map(fan => this.subagent(key, fan)),
            ...started.map(one => this.agent(`${key} ${one.id}`, { id: one.id, label: one.name ?? short(one.id), state: 'working', via: 'claude', since: iso(one.updated ?? one.started) })),
            ...handed.filter(one => !HANDED[one.status] || one.latest || !one.end || one.end >= since).map(one => this.delegation(key, one)),
          ]
        : []
    ).sort(
      (a, b) =>
        Number(a.state !== 'working') - Number(b.state !== 'working') ||
        (a.state === 'working' ? (b.since ?? '').localeCompare(a.since ?? '') : (b.end ?? '').localeCompare(a.end ?? '')),
    )
    return {
      id: `${thread.app}:${thread.id}`,
      app: thread.app,
      thread: thread.id,
      name: thread.name,
      where: where(thread),
      place: this.place(thread),
      state,
      running: session?.status === 'busy' && !beating,
      line: oneLine(line),
      ...(needs && { needs }),
      since,
      at,
      agents,
      steps,
      plan,
      lately: state === 'idle' ? [] : lately,
      track: this.track(`${thread.app}:${thread.id}`, timeline),
      ...(link && { link }),
    }
  }

  // When the heartbeats began, while the session's latest turns are heartbeats': from the moment
  // Claude Code marks the session busy while a heartbeat waits for it as its only message, until a
  // prompt that isn't one comes, or Claude Code marks it busy again for a message that isn't one.
  private beat(thread: Thread, beats: Beat[], session?: Session) {
    const run = beats.slice(beats.findLastIndex(beat => beat.after) + 1)
    const flipped = session ? (session.updated ?? session.started) : 0
    const last = run.at(-1)
    const next = !!last?.until && session?.status === 'busy' && flipped > Date.parse(last.until) && this.untaken(thread).some(row => row.meta?.schedule !== 'heartbeat')
    if (run.length && !next) return Date.parse(run[0]!.began)
    if (session?.status !== 'busy') return
    const { began, ended } = open(this.state).turn(session.id)
    if ((!began || (!!ended && Date.parse(began) < flipped)) && this.awaited(thread)) return flipped
  }

  private untaken(thread: Thread) {
    return open(this.state).untaken(thread.id)
  }

  // A heartbeat is the only message waiting for the thread.
  private awaited(thread: Thread) {
    const waiting = this.untaken(thread)
    return waiting.length > 0 && waiting.every(row => row.meta?.schedule === 'heartbeat')
  }

  // Claude Code starts a job's timeline over whenever its session respawns or renews, so each
  // thread's lane is kept here too, for a week, and survives both.
  private track(id: string, timeline: Entry[]) {
    const kept = this.tracks[id] ?? []
    const now = Date.now()
    const next = track([...kept, ...timeline.map(entry => ({ at: entry.at, state: STATES[entry.state] ?? 'idle' }))], now)
    if (JSON.stringify(next) !== JSON.stringify(kept)) {
      if (next.length) this.tracks[id] = next
      else delete this.tracks[id]
      this.saving ??= setTimeout(() => this.saveTracks(), SAVE)
    }
    const from = new Date(now - TRACK).toISOString()
    return next.map(turn => (turn.at < from ? { ...turn, at: from } : turn))
  }

  private saveTracks() {
    clearTimeout(this.saving)
    this.saving = undefined
    const file = join(this.state, 'voice', 'tracks.json')
    try {
      mkdirSync(join(this.state, 'voice'), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(this.tracks))
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      process.stderr.write(`voice: tasks: couldn't keep the lanes: ${error}\n`)
    }
  }

  // A Claude Code subagent or workflow agent, with what it handed back when its session heard it stop.
  private subagent(session: string, { id, label, startedAt, doneAt }: Fan): Agent {
    const told = this.followers.get(session)?.told.get(id)
    const state = doneAt ? (told?.state ?? 'done') : 'working'
    return this.agent(`${session} ${id}`, { id, label, state, via: 'claude', since: iso(startedAt), ...(doneAt && { end: iso(doneAt), result: told?.result }) })
  }

  // A T3 Code delegation, followed in its own hex thread's transcript when it runs on hex, else in
  // the turn items T3 Code keeps for it.
  private delegation(session: string, one: Delegation, kept?: Step[]): Agent {
    const state = HANDED[one.status] ?? 'working'
    const ended = state !== 'working'
    const steps =
      kept ??
      (one.hex
        ? this.steps(`${session} ${one.id}`)
        : this.links
            .turns(one.id)
            .flatMap(item => itemStep(item, id => this.links.name(id)) ?? [])
            .slice(0, AGENT_STEPS))
    const agent = { id: one.id, label: one.title, state, via: 't3' as const, who: who(one.model), since: one.since, ...(ended && { end: one.end, result: one.result }), link: one.link }
    return this.agent(`${session} ${one.id}`, agent, steps)
  }

  // An agent with its newest steps, its model in words, and a line: its newest step while it works,
  // what it handed back once it's done.
  private agent(key: string, agent: Omit<Agent, 'steps'>, steps = this.steps(key)): Agent {
    const follower = this.followers.get(key)
    const result = agent.result && cut(unmark(agent.result.trim()), RESULT)
    const line = agent.state === 'working' ? steps[0]?.text : (result && firstLine(result)) || steps[0]?.text
    const kind = follower?.type && follower.type !== 'general-purpose' ? follower.type : undefined
    const model = agent.who ?? [kind, who(follower?.model)].filter(Boolean).join(' · ')
    return clean({ ...agent, who: model || undefined, line: line && oneLine(line), result, steps })
  }

  private project(cwd = this.hexDir) {
    return join(this.claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  }

  // A followed transcript's newest steps, newest first.
  private steps(key: string) {
    return [...(this.followers.get(key)?.steps ?? [])].reverse()
  }

  // A working thread's transcript, and those of its subagents, workflow agents and the sessions it
  // started from this stretch of work, give its steps.
  private follow(runs: Run[]) {
    const wanted = new Map<string, [number, (path: (found: string) => () => void) => () => void]>()
    const threads = [...this.threads, ...this.loose()]
    for (const run of runs) {
      if (run.state !== 'working') continue
      const thread = threads.find(thread => `${thread.app}:${thread.id}` === run.id)!
      const { session } = thread
      const key = keyOf(thread)
      const job = session ? this.job(session).job : undefined
      const project = this.project(job?.cwd ?? thread.cwd)
      const subagents = join(project, key, 'subagents')
      const handed = this.links.delegations(thread.app, thread.id)
      if (session) wanted.set(session, [STEPS, follow => follow(join(project, `${session}.jsonl`))])
      for (const agent of run.agents) {
        const started = this.sessions.get(agent.id)
        const hex = handed.find(one => one.id === agent.id)?.hex
        const child = hex && threads.find(one => one.app === 't3' && one.id === hex)?.session
        if (agent.via === 't3' && !child) continue
        wanted.set(`${key} ${agent.id}`, [
          AGENT_STEPS,
          follow =>
            child
              ? follow(join(this.project(this.job(child).job?.cwd), `${child}.jsonl`))
              : started
                ? follow(join(this.project(started.cwd), `${agent.id}.jsonl`))
                : job?.fan?.find(one => one.id === agent.id)?.kind === 'workflow'
                  ? inRun(join(subagents, 'workflows'), `agent-${agent.id}.jsonl`, follow)
                  : follow(join(subagents, `agent-${agent.id}.jsonl`)),
        ])
      }
    }
    for (const [key, follower] of this.followers) {
      if (wanted.has(key)) continue
      follower.stop()
      this.followers.delete(key)
    }
    for (const [key, [keep, start]] of wanted) {
      if (this.followers.has(key)) continue
      const follower: Follower = { stop: () => {}, keep, steps: [], plan: [], told: new Map(), said: [] }
      this.followers.set(key, follower)
      follower.stop = start(path => {
        follower.type = readJson(path.replace(/\.jsonl$/, '.meta.json'))?.agentType
        return followTranscript(path, Math.max(0, sizeOf(path) - TAIL), (entry, updates) => this.take(follower, entry, updates()))
      })
    }
  }

  // One transcript line: its model, an agent it heard back from, its plan, its new steps, and the
  // results of steps it started earlier. A tool call is written once its input is whole, so it began
  // when the line before it was written.
  private take(follower: Follower, entry: any, updates: Update[]) {
    const at = entry.timestamp ?? new Date().toISOString()
    const began = follower.last ?? at
    if (entry.timestamp) follower.last = entry.timestamp
    if (entry.type === 'assistant' && who(entry.message?.model)) follower.model = entry.message.model
    const told = toldOf(entry)
    if (told) follower.told.set(...told)
    for (const update of updates) {
      if (update.sessionUpdate === 'plan') follower.plan = update.entries.map(entry => ({ text: oneLine(entry.content), state: PLANNED[entry.status] ?? 'pending' }))
      const back = backOf(update)
      const step = back && follower.steps.find(step => step.id === (update as { toolCallId: string }).toolCallId)
      if (step) Object.assign(step, back, { end: at, text: past(step.text) })
      const did = stepOf(update, id => this.links.name(id))
      if (did?.kind === 'say' && did.text) {
        const say = { ...did, text: oneLine(did.text), at }
        written.set(say, at)
        follower.said = [...follower.said, say].slice(-follower.keep)
      }
      if (!did?.text || (did.id ? follower.steps.some(step => step.id === did.id) : did.text === follower.steps.at(-1)?.text)) continue
      const next = { ...did, text: oneLine(did.text), at: did.id ? began : at, ...(did.id && { state: 'running' as const }) }
      written.set(next, at)
      follower.steps.push(next)
      if (follower.steps.length > follower.keep) follower.steps.shift()
    }
    this.schedule()
  }
}

// What the voice and Claude hear about a run when the caller wants to talk it through.
export function opener(run: Run) {
  const state = {
    needs: `It's waiting on the caller: ${run.needs ?? run.line}`,
    working: `It's working: ${run.line}`,
    done: `It finished: ${run.line}`,
    failed: `It failed: ${run.line}`,
    idle: `It's idle${run.line ? `; last: ${run.line}` : ''}`,
  }[run.state]
  return `The task is the hex thread ${run.name} (${run.where}, thread id ${run.thread}). ${state}`
}

function threadOf(row: Stored, general?: Stored): Thread {
  const { app, thread, session, cwd, link } = row
  return { app, id: thread, name: nameOf(row, general), session, cwd, ...(link && { link }), ...(row === general && { general: true as const }) }
}

function count(runs: Run[], state: State) {
  return runs.filter(run => run.state === state).length
}

function where(thread: Thread) {
  if (thread.general) return 'General'
  if (thread.app === 'telegram' && !thread.id.includes(':') && !thread.id.startsWith('-')) return 'DM'
  return APPS[thread.app]
}

// When the job's current state began: the oldest of the newest run of timeline entries in it.
function streak(timeline: Entry[], state?: string) {
  let since: string | undefined
  for (let i = timeline.length - 1; i >= 0 && timeline[i].state === state; i--) since = timeline[i].at
  return since
}

// A thread's last week for its lane, drawn on a log scale: what it was doing a week ago (the
// change before it), then each change. Steps within a state are kept for the last hour only, and two working runs whose gap
// (only finished or idle in it) is under a fiftieth of its age are one, since neither shows apart.
export function track(turns: Turn[], now: number): Turn[] {
  const from = now - TRACK
  const sorted = [...new Map(turns.map(turn => [turn.at, turn])).values()].sort((a, b) => a.at.localeCompare(b.at))
  const before = sorted.findLast(turn => Date.parse(turn.at) < from)
  const recent = sorted.filter(turn => Date.parse(turn.at) >= from)
  const all = before ? [before, ...recent] : recent
  const merged: Turn[] = []
  for (const turn of all) {
    if (turn.state === 'working') {
      const gap = merged.findLastIndex(one => one.state === 'working')
      const between = merged.slice(gap + 1)
      const quiet = gap >= 0 && between.length > 0 && between.every(one => one.state === 'done' || one.state === 'idle')
      if (quiet && Date.parse(turn.at) - Date.parse(between[0]!.at) < (now - Date.parse(turn.at)) / GRAIN) merged.splice(gap + 1)
    }
    merged.push(turn)
  }
  return merged.filter((turn, i) => i === 0 || turn.state !== merged[i - 1]!.state || now - Date.parse(turn.at) < FINE)
}

// A workflow agent's transcript lands in its run's own folder, so it's followed once it's written there.
function inRun(runs: string, name: string, follow: (path: string) => () => void) {
  let stop: (() => void) | undefined
  mkdirSync(runs, { recursive: true })
  const watcher = watch(runs, { recursive: true }, (_, file) => file?.endsWith(name) && find())
  find()
  return () => {
    watcher.close()
    stop?.()
  }

  function find() {
    const path = !stop && new Bun.Glob(`*/${name}`).scanSync({ cwd: runs, absolute: true }).next().value
    if (!path) return
    watcher.close()
    stop = follow(path)
  }
}

// Where a thread's steps and its agents' are kept: under its session, or while it has none (a job
// it owns can run without one), under the thread itself.
function keyOf(thread: Thread) {
  return thread.session ?? `${thread.app}:${thread.id}`
}

// A model's name in words: claude-opus-5-5 is Opus 5.5, gpt-6.1-sol is Sol.
function who(model?: string | null) {
  const id = (model ?? '').replace(/\[\w+\]$/, '').replace(/-\d{8}$/, '').replace(/^claude-/, '')
  if (/^gpt-[\d.]+$/.test(id)) return id.toUpperCase()
  const [name, ...version] = id.replace(/^gpt-[\d.]+-/, '').split('-')
  return /^[a-z]\w*$/.test(name!) && name !== 'default' ? [name!.replace(/^./, letter => letter.toUpperCase()), version.join('.')].filter(Boolean).join(' ') : undefined
}

// What a background agent handed back, from the notification its session got when it stopped, or
// a foreground agent from its Agent call's result.
function toldOf(entry: any): [string, Told] | undefined {
  const result = entry.toolUseResult
  if (entry.type === 'user' && result?.agentId && result.status === 'completed' && Array.isArray(result.content))
    return [result.agentId, { state: 'done', result: result.content.map((block: any) => block.text ?? '').join('\n') }]
  if (entry.origin?.kind !== 'task-notification') return
  const content = entry.message?.content
  const text: string = typeof content === 'string' ? content : (content ?? []).map((block: any) => block.text ?? '').join('\n')
  const id = text.match(/<task-id>([\w-]+)<\/task-id>/)?.[1]
  const said = text.match(/<result>([\s\S]*?)(?:<\/result>|$)/)?.[1]?.replace(/^\[harness:[^\]]*\]\s*/, '').trim()
  return id ? [id, { state: TOLD[text.match(/<status>(\w+)<\/status>/)?.[1] ?? ''] ?? 'stopped', ...(said && { result: said }) }] : undefined
}

// A session's records as they stood when its heartbeat began: at rest (a turn's end, which has its
// reply, even while what it handed off works on), or while work from before it still runs, as that
// work last said. With none from before it (Claude Code starts a job's
// timeline over when its session renews), it's idle. Either way it stays listed by its own time.
function before(job: Job | undefined, timeline: Entry[], from: number, working: boolean) {
  const kept = timeline.filter(entry => Date.parse(entry.at) < from)
  const last = working ? kept.at(-1) : kept.findLast(entry => entry.state !== 'working' || entry.text)
  if (!job || !last) return { job: job && { ...job, state: undefined, detail: undefined, needs: undefined }, timeline: kept }
  return { job: { ...job, state: last.state, detail: last.detail, needs: last.state === 'blocked' ? job.needs : undefined }, timeline: kept }
}

// When the timeline first showed the summary it shows now: Claude Code writes the same one again
// every few seconds while it works.
function shownSince(timeline: Entry[], summary: string) {
  let first: string | undefined
  for (let i = timeline.length - 1; i >= 0 && timeline[i]!.detail && plain(timeline[i]!.detail!) === summary; i--) first = timeline[i]!.at
  return first
}

// Claude Code's own status line while it works is often the tool it's running: a verb, then the
// tool's command, path or query (Running cd … && git commit …, Writing ~/…/t3.ts), cut short with
// …. A line in words leaves out one that names a tool call of the session's; a tool's own
// description in words stays.
function tooled(detail: string, steps: Step[]) {
  const rest = detail.replace(/…$/, '').replace(/^(Searching for|\S+)\s+/, '')
  return steps.some(step => {
    if (['say', 'think', 'plan'].includes(step.kind)) return false
    const input = step.detail && plain(step.detail)
    return !!input && rest.length > 1 && shortened(rest, input)
  })
}

// Whether shown is input shortened with … at its end or in its middle: its pieces appear in order,
// from input's start or up to its end.
function shortened(shown: string, input: string) {
  const pieces = shown.split('…').map(piece => piece.trim())
  let at = 0
  for (const piece of pieces) {
    const found = input.indexOf(piece, at)
    if (found < 0) return false
    at = found + piece.length
  }
  return input.startsWith(pieces[0]!) || input.endsWith(pieces.at(-1)!)
}

// Steps of a stretch that ended: one still running then never said how it went.
function settled(steps: Step[]) {
  return steps.map(({ state, ...step }) => (state === 'running' ? step : { ...step, ...(state && { state }) }))
}

function iso(ms?: number) {
  return ms ? new Date(ms).toISOString() : undefined
}

function cut(text: string, size: number) {
  return text.length > size ? `${text.slice(0, size - 1)}…` : text
}

function clean<T extends object>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== '')) as T
}

function short(session: string) {
  return session.slice(0, 8)
}

function plain(text: string) {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

function oneLine(text: string) {
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

function tail(path: string): Entry[] {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL)
    const chunk = Buffer.alloc(size - start)
    readSync(fd, chunk, 0, chunk.length, start)
    const lines = chunk.toString('utf8').split('\n')
    return (start ? lines.slice(1) : lines).flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  } finally {
    closeSync(fd)
  }
}

export function watchDir(dir: string, changed: (file: string | null) => void) {
  try {
    const watcher = watch(dir, (_, file) => changed(file))
    return () => watcher.close()
  } catch {
    return () => {}
  }
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
}
