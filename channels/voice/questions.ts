import { readFileSync, renameSync, statSync, watch, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { type Question as Asked, type MessageId, type Pin } from '../../hub/ledger.ts'
import { statusPost } from '../../hub/status.ts'
import { open as store, type Thread } from '../../hub/store.ts'
import { generalOf, nameOf } from './activity.ts'
import type { Sent } from './call.ts'
import { Changes } from './changes.ts'
import { before, Check } from './check.ts'
import { linkAt, Links } from './links.ts'
import { relay } from './relay.ts'
import { T3, type Fresh, type Stuck } from './t3.ts'

export type Kind = 'pick' | 'yesno' | 'do' | 'look'
// value: the button's own label, when the option stands for one.
export type Option = { label: string; value?: string; pick?: boolean }
// A page a question points to; opening it answers nothing.
export type Link = { label: string; url: string }
// An answer or a not needed given here, kept so undo can take it back whatever the check or the
// ledger says by then: the question as asked, the threads it told, the copies it reached and
// missed, whether an undo of it stopped partway, and the answer it was given over, which one undo
// takes back too.
// Marks from before these were kept have only label, at and via.
// finishing: it only finished the one under it.
export type Answer = { label: string; at: string; via: string; question?: string; told?: string[]; refs?: Ref[]; missed?: Ref[]; finishing?: boolean; undoing?: boolean; before?: Answer }
type Taken = Answer & Required<Pick<Answer, 'question' | 'told' | 'refs' | 'missed'>>
export type Ref = { app: string; thread: string; message: MessageId }
// Where a question was asked, as hex's check found it: a thread, with the message when it knows it
// (a question, a pinned post, a plain message), or a call.
export type Source = { app: string; thread?: string; message?: MessageId; call?: string }
// Each place a question was asked, for its row: the app, what the place is called there, the hex thread
// or call it is, and a link that opens it, the message itself where the app has one. A place
// without a link is still known to be where it was asked.
export type Place = { app: string; place: string; task?: string; call?: string; link?: string }
export type Question = {
  id: string
  kind: Kind
  task: string
  app: string
  topic: string
  at: string
  question: string
  context?: string
  options: Option[]
  links?: Link[]
  tag?: string
  places: Place[]
}
// hex's check rewrites the raw questions into these: one per decision, however many places asked
// it (from; refs are the open questions with buttons among them, which an answer goes back to), in
// the order that unblocks the most, with its pick and what it costs.
export type Curated = Omit<Question, 'app' | 'topic' | 'places'> & { from?: Source[]; refs?: Ref[] }
// A check.json written before places and links were typed: its places were names and a link was an
// option with a url. The next pass rewrites it.
type Written = Omit<Curated, 'options'> & { places?: string[]; options: (Option & { url?: string })[] }
export type Note = { title: string; text: string; did?: string }
export type CheckResult = {
  at: string
  why: string
  read: Record<string, number>
  asks: Curated[]
  fixed: Note[]
  flagged: Note[]
  stuck: Omit<Stuck, 'app'>[]
  inputs?: string
}
export type View = {
  version: number
  asks: Question[]
  stuck: (Stuck & { sent?: string })[]
  fresh: (Fresh & { read: boolean })[]
  check: { at: string; why: string; fixed: number; flagged: number } | null
}
type Marks = { answers: Record<string, Answer>; sent: Record<string, string>; dismissed: Record<string, string>; read: Record<string, string> }

const KEEP = 14 * 24 * 60 * 60_000
const CALLS = join(homedir(), '.claude', 'channels', 'voice', 'calls')
const WHERE: Record<string, string> = { app: 'in the app', call: 'on a call' }
const NOT_NEEDED = 'Not needed'
const PICK = /\s*[(\[]?\s*(?:←\s*)?(?:(?:my|hex[’']s) pick)\s*[)\]]?/i
// A call's title and start as its record last read, under that record's stamp.
type CallPlace = { stamp: string; title?: string; started?: string }

// Everything waiting on the owner, in one list: each question a hex thread asked with buttons or a
// poll and nobody has answered (from each app's ledger), as hex's check last rewrote them; what's
// stuck and what finished since he looked (T3 Code's own records, and what the check found). An
// answer goes back the way a tap in the chat app would, through that app's hub.
export class Questions extends Changes {
  view: Omit<View, 'version'> = { asks: [], stuck: [], fresh: [], check: null }
  counts = new Changes()
  private ledgers = new Map<string, Asked[]>()
  private threads = new Map<string, Thread>()
  private pins = new Map<string, Pin>()
  private links: Links
  private calls: string
  private result?: CheckResult
  private checkStamp?: string
  private marks: Marks
  private taking = new Set<string>()
  private pending?: ReturnType<typeof setTimeout>
  private stops: (() => void)[] = []
  private t3: T3
  private check: (why: string) => void
  private seen?: { pins: string; t3: string }
  private callPlaces = new Map<string, CallPlace>()
  private lastCallPlaces = new Map<string, CallPlace>()

  constructor(
    private state: string,
    { t3Database, t3Home, calls = CALLS, check = why => new Check(state).start(why) }: { t3Database?: string; t3Home?: string; calls?: string; check?: (why: string) => void } = {},
  ) {
    super()
    this.check = check
    this.calls = calls
    this.links = new Links(state, () => this.schedule(), t3Home)
    this.marks = readMarks(join(state, 'voice', 'marks.json'))
    this.t3 = new T3(() => this.schedule(), t3Database)
    this.stops.push(store(state).watch(() => this.schedule()))
    this.stops.push(watchDir(join(state, 'voice'), file => file === 'check.json' && this.schedule()))
    this.build()
  }

  get lastCheck() {
    return this.result
  }

  // Tasks opened with questions newer than the last check, or a call ended: hex checks again.
  opened() {
    const checked = this.result?.at ?? ''
    if ([...this.ledgers.values()].some(questions => questions.some(question => !question.answer && !question.settled && question.at > checked))) this.check('you opened Tasks')
  }

  called() {
    this.check('a call ended')
  }

  close() {
    clearTimeout(this.pending)
    this.t3.close()
    this.links.close()
    for (const stop of this.stops) stop()
  }

  find(id: string) {
    return this.view.asks.find(question => question.id === id)
  }

  // The thread's own questions and its pinned status post, for its page: one hex keeps is read
  // from hex.db as the page opens, in full.
  of(id: string) {
    const pin = this.pins.get(id)
    const thread = id.slice(id.indexOf(':') + 1)
    const text = pin && statusPost(store(this.state), thread, pin.note, Infinity)
    return { asks: this.view.asks.filter(question => question.task === id), ...(text && { pin: text }) }
  }

  // An answer goes to its first open copy, as its tap would, or to its thread in words when no
  // button takes it; the other copies settle. A copy an earlier answer missed only settles, and
  // finishing that answer settles just those.
  answer(id: string, label: string, via: string): Promise<Sent> {
    return this.take(id, label, via, async (question, taken, where, finishing) => {
      const value = question.options.find(option => option.label === label)?.value ?? label
      const refs = this.left(id, taken)
      const missed = new Set(chain(taken.before).flatMap(mark => (mark.missed ?? []).map(refId)))
      const first = refs.find(ref => !missed.has(refId(ref)))
      const settle = (ref: Ref) => this.reach(taken, ref, { type: 'settle', thread: ref.thread, message: ref.message, note: `✓ Answered ${where}: ${label}` })
      if (finishing) return this.each(refs, settle)
      if (first && this.asked(first)!.options.includes(value)) await this.reach(taken, first, { type: 'answer', thread: first.thread, message: first.message, label: value, via })
      else await this.inform(taken, first ? place(first) : question.task, `(answered ${where}) ${question.question}: ${label}`, via)
      return this.each(refs.filter(ref => !taken.refs.includes(ref)), settle)
    })
  }

  // His own words on a question, which leave it open: they reach the thread that asked it, and
  // nothing settles.
  async note(id: string, text: string, via: string): Promise<Sent> {
    const question = this.find(id)
    if (!question) throw new Error('that question is already answered or settled')
    if (this.taking.has(id)) throw new Error('an answer to that is on its way; try again in a moment')
    await this.tell(question.task, `(note written ${WHERE[via] ?? via}) ${question.question}: ${text}`, via)
    return { ...this.sent(question.task, 0), missed: 0 }
  }

  // Puts away a question that no longer matters: its own thread and every thread its open copies are
  // in hear it, so none keeps waiting, and the copies settle, which takes it off the list. A
  // thread's copies settle only once it has heard, so one it couldn't reach stays open to try
  // again; finishing skips the threads that round already told.
  dismiss(id: string, via: string): Promise<Sent> {
    return this.take(id, NOT_NEEDED, via, async (question, taken, where, finishing) => {
      const told = new Set(finishing ? round(taken.before).flatMap(mark => mark.told ?? []) : [])
      const say = async (thread: string) => {
        if (told.has(thread)) return
        await this.inform(taken, thread, `(not needed, said ${where}) ${question.question}`, via)
        told.add(thread)
      }
      await say(question.task)
      const failed: unknown[] = []
      for (const [thread, copies] of Map.groupBy(this.left(id, taken), place)) {
        const heard = await say(thread).then(
          () => true,
          error => (failed.push(error, ...copies.map(() => error)), taken.missed.push(...copies), false),
        )
        if (heard) failed.push(...(await this.each(copies, ref => this.reach(taken, ref, { type: 'settle', thread: ref.thread, message: ref.message, note: `✓ ${NOT_NEEDED}, said ${where}` }))))
      }
      return failed
    })
  }

  // Takes back an answer or a not needed given in the app or on a call, with any it was given over:
  // each copy they reached, or the ledger shows closed from here, gets its buttons back unless
  // someone has since closed it in its own app, and each thread they told hears. What fails stays
  // in the mark, so undoing again finishes it.
  async undo(id: string, via: string) {
    if (this.taking.has(id)) throw new Error('that answer is still on its way; try again in a moment')
    this.taking.add(id)
    try {
      const taken = this.marks.answers[id]
      const marks = chain(taken)
      const closed = this.refs(id).filter(ref => !this.open(ref))
      const refs = [...new Map([...marks.flatMap(mark => mark.refs ?? []), ...closed].map(ref => [refId(ref), ref])).values()].filter(ref => this.ours(ref))
      if (!taken && !refs.length) throw new Error('there is no answer here to take back')
      const curated = this.result?.asks.find(question => question.id === id)
      const failed: unknown[] = []
      const stuck: Ref[] = []
      let did = false
      for (const ref of refs)
        await relay(this.state, ref.app, { type: 'reopen', thread: ref.thread, message: ref.message, via }).then(
          () => ((did = true), marks.forEach(mark => (mark.refs = mark.refs?.filter(done => refId(done) !== refId(ref))))),
          error => (failed.push(error), stuck.push(ref)),
        )
      const said = new Set<string>()
      for (const mark of marks) {
        mark.question ??= curated?.question
        const told = (mark.told ??= curated ? [curated.task] : [])
        for (const thread of [...told]) {
          const line = `(took back) ${mark.question}: ${mark.label}`
          const sent = said.has(`${thread} ${line}`) ? Promise.resolve() : this.tell(thread, line, via)
          await sent.then(
            () => ((did = true), said.add(`${thread} ${line}`), told.splice(told.indexOf(thread), 1)),
            error => failed.push(error),
          )
        }
      }
      if (!failed.length) delete this.marks.answers[id]
      else (this.marks.answers[id] = taken ?? { label: '', at: now(), via, refs: stuck, told: [] }).undoing = true
      this.saveMarks()
      if (failed.length) throw new Error(`part of it couldn't be taken back; undo again to finish (${failed[0] instanceof Error ? failed[0].message : failed[0]})`)
      if (!did) throw new Error('nothing was left to take back: its copies were answered or closed in their own apps since')
    } finally {
      this.taking.delete(id)
    }
  }

  // Whether an answer or a not needed from here still stands on the question.
  answered(id: string) {
    return !!this.marks.answers[id]
  }

  // A stuck item's one action: hex's General is asked to do it, or it's put away until it changes.
  async act(id: string) {
    const item = this.view.stuck.find(item => item.id === id)
    if (!item) throw new Error('that is no longer stuck')
    if (item.request) {
      await this.tell(this.general(), item.request, 'app', 'prompt')
      this.marks.sent[id] = now()
    } else this.marks.dismissed[id] = now()
    this.saveMarks()
  }

  read(id: string) {
    this.marks.read[id] = now()
    this.saveMarks()
  }

  private refs(id: string): Ref[] {
    const curated = this.result?.asks.find(question => question.id === id)
    if (curated) return curated.refs ?? []
    for (const [app, questions] of this.ledgers) {
      const asked = questions.find(question => refId({ app, ...question }) === id)
      if (asked) return [{ app, thread: asked.thread, message: asked.message }]
    }
    return []
  }

  // An answer or a not needed, one at a time per question. Its first step has to go through; after
  // that every copy is tried, what went out is kept for undo, and the copies it missed are kept too.
  // Over an earlier answer it goes only once the list is past it (until then the tap came from a
  // list that hadn't caught up), and not over an undo that stopped partway. When the only copies
  // left open are ones the earlier answer missed, it's that answer being finished, and only the
  // same answer can finish it; a copy it never saw means the question was asked again.
  private async take(id: string, label: string, via: string, run: (question: Question, taken: Taken, where: string, finishing: boolean) => Promise<unknown[]>): Promise<Sent> {
    if (this.taking.has(id)) throw new Error('an answer to that is on its way; try again in a moment')
    this.taking.add(id)
    try {
      const question = this.find(id)
      const kept = this.marks.answers[id]
      const marks = chain(kept)
      const reached = marks.flatMap(mark => mark.refs ?? [])
      if (!question || (kept && (!this.refs(id).length || reached.some(ref => this.open(ref))))) throw new Error('that question is already answered or settled')
      if (kept?.undoing) throw new Error('taking back the last answer to this stopped partway; undo it again first')
      const missed = new Set(marks.flatMap(mark => (mark.missed ?? []).map(refId)))
      const taken: Taken = { label, at: now(), via, question: question.question, told: [], refs: [], missed: [], ...(kept && { before: kept }) }
      const finishing = !!kept && this.left(id, taken).every(ref => missed.has(refId(ref)))
      if (finishing && kept.label !== label) throw new Error(`part of "${kept.label}" went out; send it again to finish, or undo it`)
      if (finishing) taken.finishing = true
      const failed = await run(question, taken, WHERE[via] ?? via, finishing)
      if (!taken.told.length && !taken.refs.length) throw failed[0] ?? new Error('that question is already answered or settled')
      this.marks.answers[id] = taken
      this.saveMarks()
      const first = finishing ? round(kept).at(-1)! : taken
      return { ...this.sent(first.told?.[0] ?? place((first.refs ?? taken.refs)[0]!), taken.refs.length), missed: failed.length }
    } finally {
      this.taking.delete(id)
    }
  }

  // Tries every step, so one hub that's down doesn't stop the rest, and gives back what failed.
  private async each<T>(steps: T[], step: (each: T) => Promise<void>) {
    const failed: unknown[] = []
    for (const each of steps) await step(each).catch(error => failed.push(error))
    return failed
  }

  // The question's copies still open that no answer from here has reached.
  private left(id: string, taken: Taken) {
    const reached = new Set(chain(taken).flatMap(mark => (mark.refs ?? []).map(refId)))
    return this.refs(id).filter(ref => this.open(ref) && !reached.has(refId(ref)))
  }

  private async reach(taken: Taken, ref: Ref, message: object) {
    await relay(this.state, ref.app, message).catch(error => {
      taken.missed.push(ref)
      throw error
    })
    taken.refs.push(ref)
  }

  private async inform(taken: Taken, thread: string, content: string, via: string) {
    await this.tell(thread, content, via)
    taken.told.push(thread)
  }

  // Whether a copy is open, or was closed from here rather than by a tap in its own app or its thread.
  private ours(ref: Ref) {
    const asked = this.asked(ref)
    if (!asked) return false
    if (asked.answer) return !!WHERE[asked.answer.via]
    return !asked.settled || /^✓ (Answered|Not needed)/.test(asked.settled.note)
  }

  private sent(thread: string, settled: number) {
    return { thread, topic: this.topic(thread), settled }
  }

  private asked(ref: Ref) {
    return this.ledgers.get(ref.app)?.find(question => question.thread === ref.thread && String(question.message) === String(ref.message))
  }

  private open(ref: Ref) {
    const asked = this.asked(ref)
    return !!asked && !asked.answer && !asked.settled
  }

  // An answer is the owner's; a stuck item's request is hex's check's words, sent on the owner's tap.
  private tell(id: string, content: string, via: string, author = 'owner') {
    const [app, ...thread] = id.split(':')
    return relay(this.state, app!, { type: 'inbound', thread: thread.join(':'), content, author, meta: { user: `hex ${via}` } })
  }

  private general() {
    const general = generalOf(this.threads.values())
    if (!general) throw new Error('hex has no Telegram General to send this to')
    return `${general.app}:${general.thread}`
  }

  // What a question's thread is called, as its run on the board is.
  private topic(task: string) {
    const thread = this.threads.get(task)
    return thread ? nameOf(thread, generalOf(this.threads.values())) : task.slice(task.lastIndexOf(':') + 1)
  }

  private schedule() {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.build(), 30)
  }

  private build() {
    this.threads.clear()
    this.pins.clear()
    const questions = store(this.state).questions()
    for (const thread of store(this.state).threads()) this.threads.set(`${thread.app}:${thread.thread}`, thread)
    this.ledgers = Map.groupBy(questions.filter(question => question.app !== 'voice'), question => question.app)
    for (const pin of store(this.state).pins()) if (pin.text) this.pins.set(`${pin.app}:${pin.thread}`, pin)
    const check = join(this.state, 'voice', 'check.json')
    const stamp = stampOf(check)
    if (stamp !== this.checkStamp) {
      this.result = readJson(check)
      this.checkStamp = this.result || !stamp ? stamp : undefined
    }
    ;[this.lastCallPlaces, this.callPlaces] = [this.callPlaces, new Map()]
    this.notice()
    const used = new Set<string>()
    const curated = (this.result?.asks ?? []).flatMap((question: Written) => {
      for (const ref of question.refs ?? []) used.add(refId(ref))
      const live = question.refs?.length ? question.refs.some(ref => this.open(ref)) : !this.marks.answers[question.id]
      return live ? [this.dress(question)] : []
    })
    const raw = [...this.ledgers].flatMap(([app, questions]) =>
      questions
        .filter(question => !question.answer && !question.settled && !used.has(refId({ app, ...question })))
        .map(question => this.dress(fromLedger(app, question, before(store(this.state), app, question, Infinity).at(-1)))),
    )
    raw.sort((a, b) => b.at.localeCompare(a.at))
    const checked = this.result?.at ?? ''
    const stuck = [...this.t3.stuck, ...(this.result?.stuck ?? []).map(item => ({ ...item, app: 'hex' }))]
      .filter(item => !this.marks.dismissed[item.id])
      .map(item => ({ ...item, ...(this.marks.sent[item.id] && { sent: this.marks.sent[item.id] }) }))
    const view: Omit<View, 'version'> = {
      asks: [...raw.filter(question => question.at > checked), ...curated, ...raw.filter(question => question.at <= checked)],
      stuck,
      fresh: this.t3.fresh.map(item => ({ ...item, read: !!this.marks.read[item.id] })),
      check: this.result ? { at: this.result.at, why: this.result.why, fixed: this.result.fixed.length, flagged: this.result.flagged.length } : null,
    }
    if (JSON.stringify(view) === JSON.stringify(this.view)) return
    const moved = view.asks.length !== this.view.asks.length || view.stuck.length !== this.view.stuck.length
    this.view = view
    this.changed()
    if (moved) this.counts.changed()
  }

  // A pinned post that changed or a T3 run that ended starts a check; the first read only takes note.
  private notice() {
    const now = {
      pins: JSON.stringify([...this.pins].map(([id, pin]) => [id, pin.note])),
      t3: JSON.stringify([this.t3.stuck, this.t3.fresh].map(items => items.map(item => item.id))),
    }
    const why = !this.seen ? undefined : now.pins !== this.seen.pins ? 'a pinned post changed' : now.t3 !== this.seen.t3 ? 'a T3 run ended' : undefined
    this.seen = now
    if (why) this.check(why)
  }

  private dress({ refs, from, options, links = [], places: _names, ...question }: Written): Question {
    const [app, ...thread] = question.task.split(':')
    const pages = [...links, ...options.flatMap(({ label, url }) => (url ? [{ label, url }] : []))]
    return {
      ...question,
      app: app!,
      topic: this.topic(question.task),
      options: options.filter(option => !option.url),
      ...(pages.length && { links: pages }),
      places: this.places(from ?? [...(refs ?? []), { app: app!, thread: thread.join(':') }]),
    }
  }

  // Every place a question was asked, the ones that open first, each newest first where it's known
  // when: each call, and each thread once, at the message that matters most there: its open question, else its pinned post, else
  // any message, else the thread itself.
  private places(from: Source[]): Place[] {
    const best = new Map<string, Source>()
    for (const source of from) {
      if (!source.call && !source.thread) continue
      const key = source.call ? `call:${source.call}` : `${source.app}:${source.thread}`
      const held = best.get(key)
      if (!held || this.rank(source) < this.rank(held)) best.set(key, source)
    }
    return [...best.values()]
      .map(source => (source.call ? this.call(source.call) : this.thread(source.app, source.thread!, source.message)))
      .sort((a, b) => Number(!!b.link) - Number(!!a.link) || (b.at ?? '').localeCompare(a.at ?? ''))
      .map(({ at, ...place }) => place)
  }

  private rank({ app, thread, message, call }: Source) {
    if (call || message === undefined) return 3
    if (this.open({ app, thread: thread!, message })) return 0
    return String(this.pins.get(`${app}:${thread}`)?.message) === String(message) ? 1 : 2
  }

  // A thread's place, and when it asked there: the question's or the pinned post's time.
  private thread(app: string, thread: string, message?: MessageId): Place & { at?: string } {
    const key = `${app}:${thread}`
    const general = generalOf(this.threads.values())
    const dm = app === 'telegram' && !thread.includes(':') && !thread.startsWith('-')
    const place = general && `${general.app}:${general.thread}` === key ? 'General' : dm ? 'DM' : (this.links.title(app, thread) ?? this.threads.get(key)?.name ?? thread)
    const link = linkAt(app, this.threads.get(key)?.link, message)
    const pin = this.pins.get(key)
    const at = message === undefined ? undefined : pin && String(pin.message) === String(message) ? pin.at : this.asked({ app, thread, message })?.at
    return { app, place, task: key, ...(link && { link }), at }
  }

  // A call's record holds its whole transcript, megabytes for a long one, so its title and start are
  // read again only once the file changes, or after a read that failed; a call no build asks for drops out.
  private call(id: string): Place & { at?: string } {
    const file = join(this.calls, `${id}.json`)
    const stamp = stampOf(file)
    const kept = this.callPlaces.get(id) ?? this.lastCallPlaces.get(id)
    let known = kept?.stamp === stamp ? kept : undefined
    if (!known) {
      const call = readJson(file)
      known = { stamp: call ? stamp : '', title: call?.title, started: call?.started }
    }
    this.callPlaces.set(id, known)
    return { app: 'voice', place: known.title ?? 'a call', call: id, at: known.started }
  }

  private saveMarks() {
    const since = new Date(Date.now() - KEEP).toISOString()
    for (const book of Object.values(this.marks) as Record<string, string | Answer>[])
      for (const [id, at] of Object.entries(book)) if ((typeof at === 'string' ? at : at.at) < since) delete book[id]
    const file = join(this.state, 'voice', 'marks.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(this.marks, null, 1) + '\n')
    renameSync(`${file}.tmp`, file)
    this.schedule()
  }
}

// A question as its thread asked it: its first line is the question (what's cut from a long one opens
// its context) and the rest its context, then what hex said just before asking it (lead); the option
// the thread marked as its pick wears it.
export function fromLedger(app: string, asked: Asked, lead?: string): Curated {
  const lines = plain(asked.text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const options = asked.options.map(value => {
    const label = value.replace(PICK, '').trim() || value
    return { label, value, ...(label !== value && { pick: true }) }
  })
  const [question, rest] = cut(lines[0] ?? '', 160)
  const said = clip(
    plain(lead ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n'),
    500,
  )
  const context = [...(rest ? [rest] : []), ...lines.slice(1), ...(said ? [said] : [])].join('\n')
  return {
    id: refId({ app, ...asked }),
    kind: asked.options.length <= 2 ? 'yesno' : 'pick',
    task: `${app}:${asked.thread}`,
    at: asked.at,
    question: question.replace(/:$/, ''),
    ...(context && { context }),
    options,
    refs: [{ app, thread: asked.thread, message: asked.message }],
    from: [{ app, thread: asked.thread, message: asked.message }],
  }
}

function refId({ app, thread, message }: Ref) {
  return `${app}:${thread}:${message}`
}

// An answer and every one it was given over, newest first.
function chain(answer: Answer | undefined) {
  const marks: Answer[] = []
  for (let mark = answer; mark; mark = mark.before) marks.push(mark)
  return marks
}

// The marks of one answer: it and those that finished it, newest first, its first send last.
function round(answer: Answer | undefined) {
  const marks = chain(answer)
  const start = marks.findIndex(mark => !mark.finishing)
  return marks.slice(0, start + 1)
}

function place({ app, thread }: Ref) {
  return `${app}:${thread}`
}

function plain(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s+/gm, '')
}

const SENTENCE_END = /(?:[?!]+|(?<!(?:^|[^\p{L}\p{N}'’])\p{Ll}|\.\p{L}|(?:^|[^\p{L}\p{N}])\p{N}+|\b(?:vs|Mr|Mrs|Ms|Dr|St|approx))\.)["')\]”’]*(?=\s+["'“‘(\[]?[\p{Lu}\p{N}]|\s*$)/gu

function cut(line: string, max: number): [string, string] {
  if (line.length <= max) return [line, '']
  const ends = [...line.matchAll(SENTENCE_END)].map(found => ({ at: found.index + found[0].length, asks: found[0].includes('?') }))
  const lastAsk = line.search(/[?？][^?？]*$/)
  const fits = ends.filter(({ at }) => at >= lastAsk && at <= max)
  const end = fits.findLast(({ asks }) => asks)?.at ?? fits.findLast(({ at }) => at >= max / 2)?.at
  if (end !== undefined) return [line.slice(0, end), line.slice(end).trim()]
  const space = line.slice(0, max).search(/\s\S*$/)
  const at = space >= max / 2 ? space : max - 1 - Number(/[\uD800-\uDBFF]/.test(line[max - 2] ?? ''))
  return [`${line.slice(0, at).trimEnd()}…`, `…${line.slice(at).trim()}`]
}

export function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…` : text
}

function readMarks(file: string): Marks {
  const marks = readJson(file) ?? {}
  return { answers: marks.answers ?? {}, sent: marks.sent ?? {}, dismissed: marks.dismissed ?? {}, read: marks.read ?? {} }
}

function stampOf(path: string) {
  try {
    const { mtimeMs, size } = statSync(path)
    return `${mtimeMs}:${size}`
  } catch {
    return ''
  }
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
}

function watchDir(dir: string, changed: (file: string | null) => void) {
  try {
    const watcher = watch(dir, (_, file) => changed(file))
    return () => watcher.close()
  } catch {
    return () => {}
  }
}

function now() {
  return new Date().toISOString()
}
