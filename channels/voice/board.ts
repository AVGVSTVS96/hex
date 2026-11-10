import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

import { busy, CLAUDE, running, ownership, open } from "@hex/hub";
import type { Session, Thread as Stored } from "@hex/hub";
import { z } from "zod";

import {
  backOf,
  firstLine,
  followTranscript,
  generalOf,
  isDm,
  itemStep,
  nameOf,
  projectOf,
  past,
  sizeOf,
  stepOf,
  unmark,
} from "./activity.ts";
import type { Did, Update } from "./activity.ts";
import { Changes } from "./changes.ts";
import { HANDED, Links } from "./links.ts";
import type { Delegation } from "./links.ts";

export type State = "working" | "needs" | "done" | "failed" | "idle";

export type Step = Did & { at: string; end?: string };

export type Planned = { text: string; state: "done" | "running" | "pending" };

export type Agent = {
  id: string;
  label: string;
  state: "working" | "done" | "failed" | "stopped";
  via: "claude" | "t3";
  who?: string;
  since?: string;
  end?: string;
  line?: string;
  result?: string;
  link?: string;
  steps: Step[];
};

export type Moment = { at: string; state: State; text: string };

export type Turn = { at: string; state: State };

export type Row = Omit<Run, "needs" | "lately" | "steps" | "plan" | "agents"> & {
  agents: Omit<Agent, "steps" | "result">[];
};

export type Summary = { needs: number; working: number };

export type Finished = {
  id: string;
  title: string;
  topic: string;
  app: string;
  proof: string;
  at: string;
  run?: string;
  link?: string;
};

export type Page = Pick<Run, "id" | "app" | "thread" | "name" | "where" | "place"> &
  Partial<Pick<Run, "at" | "line" | "link">>;

export type Run = {
  id: string;
  app: string;
  thread: string;
  name: string;
  where: string;
  place: string;
  state: State;
  running: boolean;
  line: string;
  needs?: string;
  since: string;
  at: string;
  agents: Agent[];
  steps: Step[];
  plan: Planned[];
  lately: Moment[];
  track: Turn[];
  link?: string;
};

type Thread = {
  app: string;
  id: string;
  name: string;
  project: string;
  session?: string | undefined;
  cwd?: string | undefined;
  link?: string;
  general?: true;
};

const fanSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  startedAt: z.number().optional(),
  doneAt: z.number().optional(),
});

type Fan = z.infer<typeof fanSchema>;

const jobSchema = z.object({
  state: z.string().optional(),
  detail: z.string().optional(),
  needs: z.string().optional(),
  cwd: z.string().optional(),
  updatedAt: z.string().optional(),
  fan: z.array(fanSchema).optional(),
});

type Job = z.infer<typeof jobSchema>;

const entrySchema = z.object({
  at: z.string(),
  state: z.string(),
  detail: z.string().optional(),
  text: z.string().optional(),
});

type Entry = z.infer<typeof entrySchema>;

const tracksSchema = z.record(
  z.string(),
  z.array(
    z.object({ at: z.string(), state: z.enum(["working", "needs", "done", "failed", "idle"]) }),
  ),
);

const agentMetaSchema = z.object({ agentType: z.string().optional() });

const blocksSchema = z.array(z.object({ text: z.string().optional().catch(undefined) }).catch({}));

const transcriptLineSchema = z
  .object({
    timestamp: z.string().optional().catch(undefined),
    type: z.string().optional().catch(undefined),
    message: z
      .object({
        model: z.string().nullish().catch(undefined),
        content: z.union([z.string(), blocksSchema]).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    toolUseResult: z
      .object({
        agentId: z.string().optional().catch(undefined),
        status: z.string().optional().catch(undefined),
        content: blocksSchema.optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    origin: z
      .object({ kind: z.string().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  })
  .catch({});

type TranscriptLine = z.infer<typeof transcriptLineSchema>;

type Told = { state: Agent["state"]; result?: string };

type Stretch = Pick<Run, "steps" | "plan" | "agents">;

type Stop = () => void;

type Loose<T> = { [K in keyof T]: T[K] | (undefined extends T[K] ? undefined : never) };

type Follower = {
  stop: Stop;
  keep: number;
  steps: Step[];
  plan: Planned[];
  planned?: string;
  model?: string;
  type?: string | undefined;
  told: Map<string, Told>;
  last?: string;
  said: Step[];
};

type HeartbeatTurn = { began: string; until?: string; after?: string };

const TAIL = 256 * 1024;

const lineWrittenAt = new WeakMap<Step, string>();
const LATELY = 5;
const STEPS = 24;
const AGENT_STEPS = 12;
const RESULT = 600;
const KEEP = 7 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const TRACK = 7 * 24 * 60 * 60_000;
const FINE = 60 * 60_000;
const GRAIN = 50;
const SAVE = 2000;
const ORDER: State[] = ["needs", "working", "done", "failed", "idle"];

const STATES = new Map<string, State>([
  ["working", "working"],
  ["blocked", "needs"],
  ["done", "done"],
  ["failed", "failed"],
]);

const PLANNED = new Map<string, Planned["state"]>([
  ["completed", "done"],
  ["in_progress", "running"],
  ["pending", "pending"],
]);

const APPS = new Map([
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["buzz", "Buzz"],
  ["t3", "T3 Code"],
  ["voice", "Voice"],
  ["claude", "Claude Code"],
]);

const WORK = new Set(["agent", "workflow"]);
const RUNS = new Set([...WORK, "shell", "monitor"]);

const TOLD = new Map<string, Agent["state"]>([
  ["completed", "done"],
  ["failed", "failed"],
]);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Every hex thread as a run, from the records Claude Code already keeps (the same ones `claude
   agents --json` prints). A session a thread's session started (a topic's `claude -p` build), a
   job a thread owns (bin/job), or a T3 Code thread's session below one the thread handed off
   counts toward it as one of its agents. A running session that works for no thread (hex's own
   check, its memory agent, a terminal) isn't on the board. */
export class Board extends Changes {
  runs: Run[] = [];
  finished: Finished[] = [];
  summary: Summary = { needs: 0, working: 0 };
  counts = new Changes();
  private threads: Thread[] = [];
  private readonly links: Links;
  private readonly jobs = new Map<string, { job: Job | undefined; timeline: Entry[] }>();

  private sessions = new Map<string, Session>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly followers = new Map<string, Follower>();
  private readonly stretches = new Map<string, Stretch>();
  private pending?: ReturnType<typeof setTimeout>;
  private stale = { threads: true, sessions: true };
  private owners = new Map<string, string>();
  private handed = new Set<string>();
  private tops: Session[] = [];
  private readonly stops: Stop[] = [];
  private tracks: Record<string, Turn[]>;
  private saving: ReturnType<typeof setTimeout> | undefined;
  private beaten = "";
  private linked = "";
  private closed = "";
  private readonly groups = new Map<string, Run>();
  private beats = new Map<string, HeartbeatTurn[]>();

  private readonly state: string;
  private readonly hexDir: string;
  private readonly claude: string;

  constructor(state: string, hexDir: string, claude = CLAUDE, t3?: string) {
    super();
    this.state = state;
    this.hexDir = hexDir;
    this.claude = claude;
    this.tracks = readJson(tracksSchema, join(state, "voice", "tracks.json")) ?? {};
    this.links = new Links(
      state,
      () => {
        this.schedule();
      },
      t3,
    );
    this.stops.push(
      open(state).watch(() => {
        if (JSON.stringify(this.stored()) !== JSON.stringify(this.threads)) {
          this.mark("threads");
        }

        const beaten = open(state).turns.beaten();
        const linked = JSON.stringify(open(state).tasks.agentTasks());
        const closed = JSON.stringify(this.closedTasks());

        if (beaten !== this.beaten || linked !== this.linked || closed !== this.closed) {
          this.schedule();
        }

        this.beaten = beaten;
        this.linked = linked;
        this.closed = closed;
      }),
      watchDir(join(claude, "sessions"), () => {
        this.mark("sessions");
      }),
      watchDir(join(claude, "jobs"), (file) => {
        this.jobChanged(file, true);
      }),
    );
    this.build();
  }

  get(id: string) {
    return this.runs.find((run) => run.id === id);
  }

  find(id: string): Run | Page | undefined {
    const kept = this.get(id);

    if (kept !== undefined) {
      return kept;
    }

    const all = open(this.state).threads.list();
    const row = all.find(({ app, thread }) => APPS.has(app) && `${app}:${thread}` === id);

    if (row === undefined || this.links.delegated(row.app, row.thread)) {
      return;
    }

    const thread = threadOf(row, generalOf(all));

    const sessionNoOtherOpenThreadHolds =
      hasText(row.session) &&
      !all.some((one) => one !== row && one.open && one.session === row.session)
        ? row.session
        : undefined;

    const job =
      sessionNoOtherOpenThreadHolds === undefined
        ? undefined
        : readJson(
            jobSchema,
            join(this.claude, "jobs", short(sessionNoOtherOpenThreadHolds), "state.json"),
          );

    const at = job?.updatedAt ?? this.tracks[id]?.at(-1)?.at;

    const line =
      hasText(job?.detail) && job.state !== "stopped" && job.state !== "blocked"
        ? oneLine(plain(job.detail))
        : undefined;

    return {
      id,
      app: thread.app,
      thread: thread.id,
      name: thread.project,
      where: where(thread),
      place: this.place(thread),
      ...(hasText(at) && { at }),
      ...(hasText(line) && { line }),
      ...(hasText(thread.link) && { link: thread.link }),
    };
  }

  session(id: string) {
    return [...this.threads, ...this.loose()].find((thread) => `${thread.app}:${thread.id}` === id)
      ?.session;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* A session whose process died (killed, crashed) leaves its record behind, so no file change
     says it's gone. */
  refresh() {
    clearTimeout(this.pending);
    this.stale = { threads: true, sessions: true };
    this.build();
  }

  strays(): Session[] {
    return [...this.sessions.values()].filter(
      (session) =>
        busy(session) &&
        (session.helper === undefined || session.helper === "") &&
        !this.owners.has(session.id),
    );
  }

  rows(): Row[] {
    return this.runs.map(
      ({ needs: _needs, lately: _lately, steps: _steps, plan: _plan, agents, ...row }) => ({
        ...row,
        agents: agents.map(({ steps: _agentSteps, result: _result, ...agent }) => agent),
      }),
    );
  }

  close() {
    clearTimeout(this.pending);

    if (this.saving !== undefined) {
      this.saveTracks();
    }

    this.links.close();

    for (const stop of this.stops) {
      stop();
    }

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }

    for (const follower of this.followers.values()) {
      follower.stop();
    }
  }

  private mark(what: "threads" | "sessions") {
    this.stale[what] = true;
    this.schedule();
  }

  private jobChanged(id: string | null, renewedSessionGotANewFolder = false) {
    if (id === null || id === "" || !this.wanted().has(id)) {
      return;
    }

    if (renewedSessionGotANewFolder) {
      this.unwatchJob(id);
    }

    this.jobs.delete(id);
    this.watchJob(id);
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.build();
    }, 30);
  }

  private build() {
    if (this.stale.threads) {
      this.readThreads();
    }

    if (this.stale.sessions) {
      this.readSessions();
    }

    this.own();
    this.watchJobs();
    this.stale = { threads: false, sessions: false };
    this.beats = open(this.state).turns.everyBeat();
    const since = new Date(Date.now() - KEEP).toISOString();

    const threads = this.threads
      .filter((thread) => !this.links.delegated(thread.app, thread.id))
      .map((thread) => this.run(thread))
      .filter((run) => run.state === "needs" || run.state === "working" || run.at > since);

    const runs = [
      ...threads,
      ...this.loose()
        .map((thread) => this.run(thread))
        .filter((run) => run.state === "working"),
    ];

    this.follow(runs);

    for (const run of runs) {
      this.keepLastStretchUntilItWorksAgain(run);
    }

    runs.push(...this.group(runs));
    runs.sort(
      (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.at.localeCompare(a.at),
    );
    const finished = this.finish(runs);

    if (
      JSON.stringify(runs) === JSON.stringify(this.runs) &&
      JSON.stringify(finished) === JSON.stringify(this.finished)
    ) {
      return;
    }

    this.runs = runs;
    this.finished = finished;
    this.changed();
    const summary = { needs: count(runs, "needs"), working: count(runs, "working") };

    if (summary.needs === this.summary.needs && summary.working === this.summary.working) {
      return;
    }

    this.summary = summary;
    this.counts.changed();
  }

  private keepLastStretchUntilItWorksAgain(run: Run) {
    const stretch = this.stretches.get(run.id);

    if (run.state === "working") {
      this.stretches.set(run.id, { steps: run.steps, plan: run.plan, agents: run.agents });
    }

    if (run.state === "working" || !stretch) {
      return;
    }

    const thread = this.threads.find((one) => `${one.app}:${one.id}` === run.id);
    const handed = this.links.delegations(run.app, run.thread);
    Object.assign(run, {
      steps: settled(stretch.steps),
      plan: stretch.plan,
      agents: stretch.agents.map((agent) => {
        const stillHanded =
          agent.state === "working" ? handed.find((one) => one.id === agent.id) : undefined;

        return stillHanded && thread
          ? this.delegation(keyOf(thread), stillHanded, settled(agent.steps))
          : { ...agent, steps: settled(agent.steps) };
      }),
    });
  }

  private readThreads() {
    this.threads = this.stored();
  }

  private stored(): Thread[] {
    const all = open(this.state).threads.list();
    const general = generalOf(all);

    return all.filter((row) => row.open && APPS.has(row.app)).map((row) => threadOf(row, general));
  }

  private place(thread: Thread) {
    const app = where(thread);

    return app === "General" || app === "DM"
      ? app
      : (this.links.title(thread.app, thread.id) ?? thread.name);
  }

  private threadBySession() {
    return new Map(
      this.threads.flatMap((thread): [string, string][] =>
        hasText(thread.session) ? [[thread.session, `${thread.app}:${thread.id}`]] : [],
      ),
    );
  }

  private own() {
    const shownAt = (thread: string, seen = new Set<string>()): string => {
      const under = this.links.under(
        thread.slice(0, thread.indexOf(":")),
        thread.slice(thread.indexOf(":") + 1),
      );

      return hasText(under) && !seen.has(under) ? shownAt(under, seen.add(thread)) : thread;
    };

    const held = this.threadBySession();
    const known = new Map(held);
    this.handed = new Set();

    for (const id of this.sessions.keys()) {
      const owner = known.has(id) ? undefined : this.links.owner(id);

      if (!owner) {
        continue;
      }

      known.set(id, owner.thread);

      if (owner.handed && shownAt(owner.thread) === owner.thread) {
        this.handed.add(id);
      }
    }

    const resolved = [...this.sessions.values()].map((session) => ({
      session,
      ...ownership(session, held, this.sessions, {
        owners: known,
        boundary: t3Boundary((id) => this.links.runs(id)),
        display: shownAt,
      }),
    }));

    const shown = new Set(
      this.threads
        .filter((thread) => !this.links.delegated(thread.app, thread.id))
        .map((thread) => `${thread.app}:${thread.id}`),
    );

    this.owners = new Map(
      resolved.flatMap(({ session, thread }): [string, string][] =>
        hasText(thread) ? [[session.id, thread]] : [],
      ),
    );
    this.tops = [];

    for (const { session, thread: owner, top: run } of resolved) {
      if (!hasText(owner) || shown.has(owner) || held.has(session.id)) {
        continue;
      }

      if (run.id === session.id) {
        this.tops.push(session);
      } else {
        this.owners.set(session.id, `claude:${short(run.id)}`);
      }
    }
  }

  private loose(): Thread[] {
    return this.tops.map((session) => ({
      app: "claude",
      id: short(session.id),
      name: session.name ?? short(session.id),
      project: session.name ?? short(session.id),
      session: session.id,
      cwd: session.cwd,
    }));
  }

  private started(thread: Thread) {
    const key = `${thread.app}:${thread.id}`;

    return [...this.sessions.values()].filter(
      (session) =>
        session.id !== thread.session &&
        busy(session) &&
        this.owners.get(session.id) === key &&
        !this.handed.has(session.id),
    );
  }

  private wanted() {
    return new Set(
      [...this.threads, ...this.loose()].flatMap((thread) =>
        hasText(thread.session) ? [short(thread.session)] : [],
      ),
    );
  }

  private watchJobs() {
    const wanted = this.wanted();

    for (const id of this.watchers.keys()) {
      if (!wanted.has(id)) {
        this.unwatchJob(id);
      }
    }

    for (const id of this.jobs.keys()) {
      if (!wanted.has(id)) {
        this.jobs.delete(id);
      }
    }

    for (const id of wanted) {
      this.watchJob(id);
    }
  }

  private watchJob(id: string) {
    if (this.watchers.has(id)) {
      return;
    }

    const watcher = tryWatch(join(this.claude, "jobs", id), () => {
      this.jobChanged(id);
    });

    if (watcher !== undefined) {
      this.watchers.set(id, watcher);
    }
  }

  private unwatchJob(id: string) {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }

  private readSessions() {
    this.sessions = running(open(this.state), this.claude);
  }

  private job(session: string) {
    const id = short(session);
    let cached = this.jobs.get(id);

    if (!cached) {
      const dir = join(this.claude, "jobs", id);
      cached = {
        job: readJson(jobSchema, join(dir, "state.json")),
        timeline: tail(join(dir, "timeline.jsonl")),
      };
      this.jobs.set(id, cached);
    }

    return cached;
  }

  private run(thread: Thread): Run {
    const { job: current, timeline: currentTimeline } = hasText(thread.session)
      ? this.job(thread.session)
      : { job: undefined, timeline: [] };

    let job = current;
    let timeline = currentTimeline;
    const session = hasText(thread.session) ? this.sessions.get(thread.session) : undefined;
    const started = this.started(thread);
    const handed = this.links.delegations(thread.app, thread.id);
    const out = handed.filter((one) => !HANDED[one.status]);
    const beats = hasText(thread.session) ? (this.beats.get(thread.session) ?? []) : [];
    const beat = this.heartbeatsBegan(thread, beats, session);

    const earlier =
      beat !== undefined &&
      job?.fan?.some(
        (fan) => RUNS.has(fan.kind) && !hasTime(fan.doneAt) && (fan.startedAt ?? 0) < beat,
      ) === true;

    if (beat !== undefined && job?.state !== "blocked") {
      ({ job, timeline } = asHeartbeatFound(job, timeline, beat, earlier));
    }

    const beating = beat !== undefined && !earlier;

    const outside = (at: string) =>
      !beats.some((one) => at >= one.began && (!hasText(one.until) || at < one.until));

    const ours = (step: Step) => outside(lineWrittenAt.get(step) ?? step.at);
    const known = STATES.get(job?.state ?? "");
    const live = (busy(session) && !beating) || started.length > 0 || out.length > 0;
    let state: State = live ? "working" : (known ?? "idle");

    if (!live && ((state === "working" && !session) || job?.detail?.startsWith("(idle") === true)) {
      state = "idle";
    }

    const lately = timeline
      .filter(
        (entry): entry is Entry & { detail: string } =>
          hasText(entry.text) && hasText(entry.detail) && outside(entry.at),
      )
      .slice(-LATELY)
      .toReversed()
      .map((entry) => ({
        at: entry.at,
        state: STATES.get(entry.state) ?? "idle",
        text: plain(entry.detail),
      }));

    const last = Math.max(
      session ? (session.updated ?? session.started) : 0,
      ...started.map((one) => one.updated ?? one.started),
      ...out.map((one) => (hasText(one.since) ? Date.parse(one.since) : 0)),
    );

    const at = job?.updatedAt ?? timeline.at(-1)?.at ?? new Date(live ? last : 0).toISOString();
    const asked = state === "needs" ? plain(job?.needs ?? job?.detail ?? "") : "";
    const needs = asked === "" ? undefined : asked;

    const began = Math.min(
      ...started.map((one) => one.updated ?? one.started),
      ...out.map((one) => (hasText(one.since) ? Date.parse(one.since) : Date.now())),
      session && busy(session) ? (session.updated ?? session.started) : Infinity,
    );

    const since =
      state === "working" && known !== "working"
        ? new Date(began).toISOString()
        : state === "working" || state === "needs"
          ? (currentStateBegan(timeline, job?.state) ?? at)
          : at;

    const { link } = thread;
    const key = keyOf(thread);
    const follower = this.followers.get(key);

    const thisStretchWithRoomForALateBusyStatus = new Date(
      Date.parse(since) - 30_000,
    ).toISOString();

    const steps =
      state === "working"
        ? this.newestStepsFirst(key).filter(
            (step) => ours(step) && (step.end ?? step.at) >= thisStretchWithRoomForALateBusyStatus,
          )
        : [];

    const plan =
      state === "working" &&
      hasText(follower?.planned) &&
      follower.planned >= thisStretchWithRoomForALateBusyStatus
        ? follower.plan
        : [];

    const said =
      state === "working"
        ? this.followers.get(key)?.said.findLast((step) => step.at >= since && ours(step))
        : undefined;

    const detail = job?.state !== "stopped" && hasText(job?.detail) ? plain(job.detail) : undefined;

    const line =
      [needs, said?.text, state === "working" ? "" : [detail, lately[0]?.text].find(hasText)].find(
        hasText,
      ) ?? "";

    const agents = (
      state === "working"
        ? [
            ...(job?.fan ?? [])
              .filter(
                (fan) =>
                  WORK.has(fan.kind) &&
                  (!hasTime(fan.doneAt) || fan.doneAt >= Date.parse(since)) &&
                  !(beat !== undefined && (fan.startedAt ?? 0) >= beat),
              )
              .map((fan) => this.subagent(key, fan)),
            ...started.map((one) =>
              this.agent(`${key} ${one.id}`, {
                id: one.id,
                label: one.name ?? short(one.id),
                state: "working",
                via: "claude",
                since: iso(one.updated ?? one.started),
              }),
            ),
            ...handed
              .filter(
                (one) => !HANDED[one.status] || one.latest || !hasText(one.end) || one.end >= since,
              )
              .map((one) => this.delegation(key, one)),
          ]
        : []
    ).toSorted(newest);

    return {
      id: `${thread.app}:${thread.id}`,
      app: thread.app,
      thread: thread.id,
      name: thread.project,
      where: where(thread),
      place: this.place(thread),
      state,
      running: session?.status === "busy" && !beating,
      line: oneLine(line),
      ...(needs !== undefined && { needs }),
      since,
      at,
      agents,
      steps,
      plan,
      lately: state === "idle" ? [] : lately,
      track: this.track(`${thread.app}:${thread.id}`, timeline),
      ...(hasText(link) && { link }),
    };
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* A run of a project's own has no thread: it works while its agents do, and stays on the board
     until hex restarts, at most a week. */
  private group(runs: Run[]): Run[] {
    const links = Object.entries(open(this.state).tasks.agentTasks());

    const taskOf = (agent: Agent) =>
      links.find(([id]) => id === agent.id || agent.id.startsWith(id))?.[1];

    const moved = new Map<string, Agent[]>();

    for (const run of runs) {
      run.agents = run.agents.filter((agent) => {
        const task = taskOf(agent);
        const to = task && home(task, runs, run);

        if (!hasText(to) || to === run.id) {
          return true;
        }

        const keptFromAnEndedStretch = run.state !== "working" && agent.state === "working";
        const moving = keptFromAnEndedStretch ? { ...agent, state: "done" as const } : agent;
        moved.set(to, [...(moved.get(to) ?? []), moving]);

        return false;
      });
    }

    const now = new Date().toISOString();
    const fresh: Run[] = [];

    for (const [id, agents] of moved) {
      const run = runs.find((one) => one.id === id);

      if (!run) {
        fresh.push(this.projectRun(id, agents));
        continue;
      }

      run.agents = [...run.agents, ...agents].toSorted(newest);
      const working = agents.filter((agent) => agent.state === "working");

      if (working.length > 0 && run.state !== "working" && run.state !== "needs") {
        Object.assign(run, {
          state: "working",
          since: earliest(working.map((agent) => agent.since ?? run.at)),
        });
      }
    }

    for (const run of fresh) {
      this.groups.set(run.id, run);
    }

    const since = new Date(Date.now() - KEEP).toISOString();

    for (const [id, kept] of this.groups) {
      if (fresh.some((run) => run.id === id)) {
        continue;
      }

      if (kept.at < since) {
        this.groups.delete(id);
        continue;
      }

      if (kept.state !== "working") {
        fresh.push(kept);
        continue;
      }

      const agentsLeftTheBoard = {
        ...kept,
        state: "done" as const,
        at: now,
        agents: kept.agents.map((agent) =>
          agent.state === "working" ? { ...agent, state: "done" as const, end: now } : agent,
        ),
      };

      const ended = {
        ...agentsLeftTheBoard,
        track: this.track(id, busyness(agentsLeftTheBoard.agents)),
      };

      this.groups.set(id, ended);
      fresh.push(ended);
    }

    return fresh;
  }

  private finish(runs: Run[]): Finished[] {
    const store = open(this.state);
    const all = store.threads.list();
    const general = generalOf(all);

    const generalOrDM = (row?: Stored) =>
      !row || ["General", "DM"].includes(where(threadOf(row, general)));

    return this.closedTasks().flatMap((task) => {
      if (task.closed === undefined) {
        return [];
      }

      const owner = all.find((row) => row.thread === task.owner);

      const whereItWasClosedOrItsAgentsStartedElseItsProof =
        !hasText(task.project) && generalOrDM(owner)
          ? [
              ...store.tasks.worked(task.id),
              store.messages.get(task.proof?.split(/\s/u)[0] ?? "")?.to,
            ]
          : [];

      const thread =
        whereItWasClosedOrItsAgentsStartedElseItsProof
          .map((place) => all.find((row) => row.thread === place))
          .find((row) => row !== undefined && !generalOrDM(row)) ?? owner;

      const id = home({ ...task, owner: thread?.thread ?? task.owner }, runs);
      const run = runs.find((one) => one.id === id);
      const topic = run?.name ?? task.project ?? (thread ? projectOf(thread, general) : "hex");

      return {
        id: task.id,
        title: task.title,
        topic,
        app: thread?.app ?? "hex",
        proof: oneLine(plain(task.proof ?? "")),
        at: task.closed,
        ...(run && { run: run.id }),
        ...(hasText(thread?.link) && { link: thread.link }),
      };
    });
  }

  private closedTasks() {
    return open(this.state).tasks.finished(new Date(Date.now() - DAY).toISOString());
  }

  private projectRun(id: string, agents: Agent[]): Run {
    const name = id.slice("project:".length);
    const working = agents.filter((agent) => agent.state === "working");

    const state: State =
      working.length > 0
        ? "working"
        : agents.some((agent) => agent.state === "failed")
          ? "failed"
          : "done";

    const at =
      agents
        .flatMap((agent) => [agent.since, agent.end].filter(hasText))
        .toSorted()
        .at(-1) ??
      this.groups.get(id)?.at ??
      new Date().toISOString();

    const since = earliest(working.map((agent) => agent.since ?? at)) ?? at;
    const line = working[0]?.line ?? agents[0]?.line ?? "";

    return {
      id,
      app: "hex",
      thread: id,
      name,
      where: "hex",
      place: name,
      state,
      running: false,
      line: oneLine(line),
      since,
      at,
      agents: agents.toSorted(newest),
      steps: [],
      plan: [],
      lately: [],
      track: this.track(id, busyness(agents)),
    };
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* Heartbeats begin when Claude Code marks the session busy while a heartbeat waits as its only
     message, and last until a prompt that isn't one comes, or Claude Code marks it busy again for
     a message that isn't one. */
  private heartbeatsBegan(thread: Thread, beats: HeartbeatTurn[], session?: Session) {
    const heartbeatsSinceLastPrompt = beats.slice(
      beats.findLastIndex((beat) => hasText(beat.after)) + 1,
    );

    const flipped = session ? (session.updated ?? session.started) : 0;
    const first = heartbeatsSinceLastPrompt[0];
    const last = heartbeatsSinceLastPrompt.at(-1);

    const busyAgainForAnotherMessage =
      hasText(last?.until) &&
      session?.status === "busy" &&
      flipped > Date.parse(last.until) &&
      this.untaken(thread).some((row) => row.meta?.schedule !== "heartbeat");

    if (first !== undefined && !busyAgainForAnotherMessage) {
      return Date.parse(first.began);
    }

    if (session?.status !== "busy") {
      return;
    }

    const { began, ended } = open(this.state).turns.get(session.id);

    if (
      (!hasText(began) || (hasText(ended) && Date.parse(began) < flipped)) &&
      this.onlyAHeartbeatWaits(thread)
    ) {
      return flipped;
    }
  }

  private untaken(thread: Thread) {
    return open(this.state).messages.untaken(thread.id);
  }

  private onlyAHeartbeatWaits(thread: Thread) {
    const waiting = this.untaken(thread);

    return waiting.length > 0 && waiting.every((row) => row.meta?.schedule === "heartbeat");
  }

  private track(id: string, timelineClaudeCodeStartsOverOnRenew: Entry[]) {
    const kept = this.tracks[id] ?? [];
    const now = Date.now();

    const next = track(
      [
        ...kept,
        ...timelineClaudeCodeStartsOverOnRenew.map((entry) => ({
          at: entry.at,
          state: STATES.get(entry.state) ?? "idle",
        })),
      ],
      now,
    );

    if (JSON.stringify(next) !== JSON.stringify(kept)) {
      if (next.length > 0) {
        this.tracks[id] = next;
      } else {
        this.tracks = Object.fromEntries(Object.entries(this.tracks).filter(([one]) => one !== id));
      }

      this.saving ??= setTimeout(() => {
        this.saveTracks();
      }, SAVE);
    }

    const from = new Date(now - TRACK).toISOString();

    return next.map((turn) => (turn.at < from ? { ...turn, at: from } : turn));
  }

  private saveTracks() {
    clearTimeout(this.saving);
    this.saving = undefined;

    const file = join(this.state, "voice", "tracks.json");

    try {
      mkdirSync(join(this.state, "voice"), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(this.tracks));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      process.stderr.write(`voice: tasks: couldn't keep the lanes: ${String(error)}\n`);
    }
  }

  private subagent(session: string, { id, label, startedAt, doneAt }: Fan): Agent {
    const told = this.followers.get(session)?.told.get(id);
    const state = hasTime(doneAt) ? (told?.state ?? "done") : "working";

    return this.agent(`${session} ${id}`, {
      id,
      label,
      state,
      via: "claude",
      since: iso(startedAt),
      ...(hasTime(doneAt) && { end: iso(doneAt), result: told?.result }),
    });
  }

  private delegation(session: string, one: Delegation, kept?: Step[]): Agent {
    const state: Agent["state"] = HANDED[one.status] ?? "working";
    const ended = state !== "working";

    const steps =
      kept ??
      (hasText(one.hex)
        ? this.newestStepsFirst(`${session} ${one.id}`)
        : this.links
            .turns(one.id)
            .flatMap((item) => itemStep(item, (id) => this.links.name(id)) ?? [])
            .slice(0, AGENT_STEPS));

    const agent = {
      id: one.id,
      label: one.title,
      state,
      via: "t3" as const,
      who: who(one.model),
      since: one.since,
      ...(ended && { end: one.end, result: one.result }),
      link: one.link,
    };

    return this.agent(`${session} ${one.id}`, agent, steps);
  }

  private agent(
    key: string,
    agent: Loose<Omit<Agent, "steps">>,
    steps = this.newestStepsFirst(key),
  ): Agent {
    const follower = this.followers.get(key);

    const result = hasText(agent.result) ? cut(unmark(agent.result.trim()), RESULT) : undefined;

    const line =
      agent.state === "working"
        ? steps[0]?.text
        : ([hasText(result) ? firstLine(result) : undefined, steps[0]?.text].find(hasText) ??
          steps[0]?.text);

    const kind =
      hasText(follower?.type) && follower.type !== "general-purpose" ? follower.type : undefined;

    const model = agent.who ?? [kind, who(follower?.model)].filter(hasText).join(" · ");

    const { id, label, state, via, since, end, link } = agent;

    return {
      id,
      label,
      state,
      via,
      ...(hasText(model) && { who: model }),
      ...(hasText(since) && { since }),
      ...(hasText(end) && { end }),
      ...(hasText(line) && { line: oneLine(line) }),
      ...(hasText(result) && { result }),
      ...(hasText(link) && { link }),
      steps,
    };
  }

  private project(cwd = this.hexDir) {
    return join(this.claude, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  }

  private newestStepsFirst(key: string) {
    return (this.followers.get(key)?.steps ?? []).toReversed();
  }

  private follow(runs: Run[]) {
    const wanted = new Map<string, [number, (path: (found: string) => Stop) => Stop]>();
    const threads = [...this.threads, ...this.loose()];

    for (const run of runs) {
      if (run.state !== "working") {
        continue;
      }

      const thread = threads.find((one) => `${one.app}:${one.id}` === run.id);

      if (thread === undefined) {
        continue;
      }

      const { session } = thread;
      const key = keyOf(thread);
      const job = hasText(session) ? this.job(session).job : undefined;
      const project = this.project(job?.cwd ?? thread.cwd);
      const subagents = join(project, key, "subagents");
      const handed = this.links.delegations(thread.app, thread.id);

      if (hasText(session)) {
        wanted.set(session, [STEPS, (follow) => follow(join(project, `${session}.jsonl`))]);
      }

      for (const agent of run.agents) {
        const started = this.sessions.get(agent.id);
        const hex = handed.find((one) => one.id === agent.id)?.hex;

        const child = hasText(hex)
          ? threads.find((one) => one.app === "t3" && one.id === hex)?.session
          : undefined;

        if (agent.via === "t3" && !hasText(child)) {
          continue;
        }

        wanted.set(`${key} ${agent.id}`, [
          AGENT_STEPS,
          (follow) =>
            hasText(child)
              ? follow(join(this.project(this.job(child).job?.cwd), `${child}.jsonl`))
              : started
                ? follow(join(this.project(started.cwd), `${agent.id}.jsonl`))
                : job?.fan?.find((one) => one.id === agent.id)?.kind === "workflow"
                  ? followOnceWrittenInItsRunFolder(
                      join(subagents, "workflows"),
                      `agent-${agent.id}.jsonl`,
                      follow,
                    )
                  : follow(join(subagents, `agent-${agent.id}.jsonl`)),
        ]);
      }
    }

    for (const [key, follower] of this.followers) {
      if (wanted.has(key)) {
        continue;
      }

      follower.stop();
      this.followers.delete(key);
    }

    for (const [key, [keep, start]] of wanted) {
      if (this.followers.has(key)) {
        continue;
      }

      const follower: Follower = {
        stop: nothingToStop,
        keep,
        steps: [],
        plan: [],
        told: new Map(),
        said: [],
      };

      this.followers.set(key, follower);
      follower.stop = start((path) => {
        follower.type = readJson(
          agentMetaSchema,
          path.replace(/\.jsonl$/u, ".meta.json"),
        )?.agentType;

        const stop = followTranscript(path, Math.max(0, sizeOf(path) - TAIL), (entry, updates) => {
          this.take(follower, transcriptLineSchema.parse(entry), updates());
        });

        return () => {
          void stop();
        };
      });
    }
  }

  private take(follower: Follower, entry: TranscriptLine, updates: Update[]) {
    const at = entry.timestamp ?? new Date().toISOString();
    const toolCallBeganWhenTheLineBeforeWasWritten = follower.last ?? at;

    if (hasText(entry.timestamp)) {
      follower.last = entry.timestamp;
    }

    const model = entry.message?.model;

    if (entry.type === "assistant" && hasText(model) && hasText(who(model))) {
      follower.model = model;
    }

    const told = toldOf(entry);

    if (told) {
      follower.told.set(...told);
    }

    for (const update of updates) {
      if (update.sessionUpdate === "plan") {
        follower.plan = update.entries.map((planned) => ({
          text: oneLine(planned.content),
          state: PLANNED.get(planned.status) ?? "pending",
        }));
        follower.planned = at;
      }

      const back = backOf(update);

      const ended =
        back && update.sessionUpdate === "tool_call_update"
          ? follower.steps.find((one) => one.id === update.toolCallId)
          : undefined;

      if (ended) {
        Object.assign(ended, back, { end: at, text: past(ended.text) });
      }

      const did = stepOf(update, (id) => this.links.name(id));

      if (did?.kind === "say" && hasText(did.text)) {
        const say = { ...did, at };
        lineWrittenAt.set(say, at);
        follower.said = [...follower.said, say].slice(-follower.keep);
      }

      if (
        did === undefined ||
        !hasText(did.text) ||
        (hasText(did.id)
          ? follower.steps.some((one) => one.id === did.id)
          : did.text === follower.steps.at(-1)?.text)
      ) {
        continue;
      }

      const next = {
        ...did,
        text: did.kind === "say" ? did.text : oneLine(did.text),
        at: hasText(did.id) ? toolCallBeganWhenTheLineBeforeWasWritten : at,
        ...(hasText(did.id) && { state: "running" as const }),
      };

      lineWrittenAt.set(next, at);
      follower.steps.push(next);

      if (follower.steps.length > follower.keep) {
        follower.steps.shift();
      }
    }

    this.schedule();
  }
}

function home(task: { owner: string; project?: string }, runs: Run[], workedIn?: Run) {
  const owner = runs.find((run) => run.thread === task.owner);

  if (owner && ofOneProject(owner)) {
    return owner.id;
  }

  if (!hasText(task.project)) {
    return workedIn && workedIn.app !== "claude" && ofOneProject(workedIn)
      ? workedIn.id
      : owner?.id;
  }

  const parts = runs.filter((run) => run.name === task.project && ofOneProject(run));

  return (
    (parts.find((run) => run.place === task.project) ?? parts[0])?.id ?? `project:${task.project}`
  );
}

function ofOneProject(run: Run) {
  return run.where !== "General" && run.where !== "DM";
}

function newest(a: Agent, b: Agent) {
  return (
    Number(a.state !== "working") - Number(b.state !== "working") ||
    (a.state === "working"
      ? (b.since ?? "").localeCompare(a.since ?? "")
      : (b.end ?? "").localeCompare(a.end ?? ""))
  );
}

function busyness(agents: Agent[]): Entry[] {
  const marks = agents.flatMap((agent) => [
    ...(hasText(agent.since) ? [{ at: agent.since, step: 1, state: "working" }] : []),
    ...(hasText(agent.since) && hasText(agent.end)
      ? [{ at: agent.end, step: -1, state: agent.state === "failed" ? "failed" : "done" }]
      : []),
  ]);

  let atWork = 0;

  return marks
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.step - b.step)
    .flatMap((mark) => {
      const was = atWork;
      atWork += mark.step;

      return (was === 0 && atWork > 0) || (was > 0 && atWork === 0)
        ? [{ at: mark.at, state: mark.state }]
        : [];
    });
}

export function opener(run: Run) {
  const state = {
    needs: `It's waiting on the caller: ${run.needs ?? run.line}`,
    working: `It's working: ${run.line}`,
    done: `It finished: ${run.line}`,
    failed: `It failed: ${run.line}`,
    idle: `It's idle${run.line === "" ? "" : `; last: ${run.line}`}`,
  }[run.state];

  if (run.app === "hex") {
    return `The task is ${run.name}, work hex's agents do for it, with no thread of its own. ${state}`;
  }

  return `The task is the thread ${run.place} (${run.where}, thread id ${run.thread})${run.place === run.name ? "" : `, part of the project ${run.name}`}. ${state}`;
}

function threadOf(row: Stored, general?: Stored): Thread {
  const { app, thread, session, cwd, link } = row;

  return {
    app,
    id: thread,
    name: nameOf(row, general),
    project: projectOf(row, general),
    session,
    cwd,
    ...(hasText(link) && { link }),
    ...(row === general && { general: true as const }),
  };
}

function count(runs: Run[], state: State) {
  return runs.filter((run) => run.state === state).length;
}

function where(thread: Thread) {
  if (thread.general) {
    return "General";
  }

  if (isDm({ app: thread.app, thread: thread.id })) {
    return "DM";
  }

  return APPS.get(thread.app) ?? thread.app;
}

function currentStateBegan(timeline: Entry[], state?: string) {
  let since: string | undefined;

  for (const entry of timeline.toReversed()) {
    if (entry.state !== state) {
      break;
    }

    since = entry.at;
  }

  return since;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A thread's last week for its lane, drawn on a log scale. Two working runs whose gap (only
   finished or idle in it) is under a fiftieth of its age are one, since neither shows apart. */
export function track(turns: Turn[], now: number): Turn[] {
  const from = now - TRACK;

  const sorted = [...new Map(turns.map((turn) => [turn.at, turn])).values()].toSorted((a, b) =>
    a.at.localeCompare(b.at),
  );

  const aWeekAgo = sorted.findLast((turn) => Date.parse(turn.at) < from);
  const recent = sorted.filter((turn) => Date.parse(turn.at) >= from);
  const all = aWeekAgo ? [aWeekAgo, ...recent] : recent;
  const merged: Turn[] = [];

  for (const turn of all) {
    if (turn.state === "working") {
      const gap = merged.findLastIndex((one) => one.state === "working");
      const between = merged.slice(gap + 1);

      const quietSince = between[0];

      const quiet =
        gap !== -1 &&
        quietSince !== undefined &&
        between.every((one) => one.state === "done" || one.state === "idle");

      if (
        quiet &&
        Date.parse(turn.at) - Date.parse(quietSince.at) < (now - Date.parse(turn.at)) / GRAIN
      ) {
        merged.splice(gap + 1);
      }
    }

    merged.push(turn);
  }

  return merged.filter(
    (turn, i) => i === 0 || turn.state !== merged[i - 1]?.state || now - Date.parse(turn.at) < FINE,
  );
}

function followOnceWrittenInItsRunFolder(
  runs: string,
  name: string,
  follow: (path: string) => Stop,
) {
  let stop: Stop | undefined;
  mkdirSync(runs, { recursive: true });

  const watcher = watch(runs, { recursive: true }, (_, file) => {
    if (file?.endsWith(name) === true) {
      find();
    }
  });

  find();

  return () => {
    watcher.close();
    stop?.();
  };

  function find() {
    if (stop) {
      return;
    }

    const [path] = new Bun.Glob(`*/${name}`).scanSync({ cwd: runs, absolute: true });

    if (!hasText(path)) {
      return;
    }

    watcher.close();
    stop = follow(path);
  }
}

function keyOf(thread: Thread) {
  return thread.session ?? `${thread.app}:${thread.id}`;
}

function who(model?: string | null) {
  const id = (model ?? "")
    .replace(/\[\w+\]$/u, "")
    .replace(/-\d{8}$/u, "")
    .replace(/^claude-/u, "");

  if (/^gpt-[\d.]+$/u.test(id)) {
    return id.toUpperCase();
  }

  const [name = "", ...version] = id.replace(/^gpt-[\d.]+-/u, "").split("-");

  return /^[a-z]\w*$/u.test(name) && name !== "default"
    ? [name.replace(/^./u, (letter) => letter.toUpperCase()), version.join(".")]
        .filter(hasText)
        .join(" ")
    : undefined;
}

function joinedText(blocks: z.infer<typeof blocksSchema>) {
  return blocks.map((block) => block.text ?? "").join("\n");
}

function toldOf(entry: TranscriptLine): [string, Told] | undefined {
  const result = entry.toolUseResult;

  if (
    entry.type === "user" &&
    hasText(result?.agentId) &&
    result.status === "completed" &&
    result.content !== undefined
  ) {
    return [result.agentId, { state: "done", result: joinedText(result.content) }];
  }

  if (entry.origin?.kind !== "task-notification") {
    return;
  }

  const content = entry.message?.content ?? [];
  const text = Array.isArray(content) ? joinedText(content) : content;
  const id = /<task-id>([\w-]+)<\/task-id>/u.exec(text)?.[1];

  const said = /<result>([\s\S]*?)(?:<\/result>|$)/u
    .exec(text)?.[1]
    ?.replace(/^\[harness:[^\]]*\]\s*/u, "")
    .trim();

  return hasText(id)
    ? [
        id,
        {
          state: TOLD.get(/<status>(\w+)<\/status>/u.exec(text)?.[1] ?? "") ?? "stopped",
          ...(hasText(said) && { result: said }),
        },
      ]
    : undefined;
}

function asHeartbeatFound(job: Job | undefined, timeline: Entry[], from: number, working: boolean) {
  const kept = timeline.filter((entry) => Date.parse(entry.at) < from);

  const last = working
    ? kept.at(-1)
    : kept.findLast((entry) => entry.state !== "working" || hasText(entry.text));

  if (!job || !last) {
    return {
      job: job && { ...job, state: undefined, detail: undefined, needs: undefined },
      timeline: kept,
    };
  }

  return {
    job: {
      ...job,
      state: last.state,
      detail: last.detail,
      needs: last.state === "blocked" ? job.needs : undefined,
    },
    timeline: kept,
  };
}

function settled(steps: Step[]) {
  return steps.map(({ state, ...step }) =>
    state === "running" ? step : { ...step, ...(state !== undefined && { state }) },
  );
}

function iso(ms?: number) {
  return hasTime(ms) ? new Date(ms).toISOString() : undefined;
}

function cut(text: string, size: number) {
  return text.length > size ? `${text.slice(0, size - 1)}…` : text;
}

function short(session: string) {
  return session.slice(0, 8);
}

function plain(text: string) {
  return text
    .replaceAll(/\*\*|__|`/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function oneLine(text: string) {
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function tail(path: string): Entry[] {
  let fd: number;

  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }

  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL);
    const chunk = Buffer.alloc(size - start);
    readSync(fd, chunk, 0, chunk.length, start);
    const lines = chunk.toString("utf-8").split("\n");

    return (start > 0 ? lines.slice(1) : lines).flatMap((line) => {
      const entry = parseJson(entrySchema, line);

      return entry === undefined ? [] : [entry];
    });
  } finally {
    closeSync(fd);
  }
}

export function watchDir(dir: string, changed: (file: string | null) => void): Stop {
  try {
    const watcher = watch(dir, (_, file) => {
      changed(file);
    });

    return () => {
      watcher.close();
    };
  } catch {
    return nothingToStop;
  }
}

function nothingToStop(): void {
  return undefined;
}

function tryWatch(path: string, changed: () => void): FSWatcher | undefined {
  try {
    return watch(path, changed);
  } catch {
    return undefined;
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readJson<T>(schema: z.ZodType<T>, path: string): T | undefined {
  try {
    return parseJson(schema, readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function hasText(text: string | null | undefined): text is string {
  return text !== undefined && text !== null && text !== "";
}

function hasTime(ms: number | undefined): ms is number {
  return ms !== undefined && ms !== 0;
}

function earliest(times: string[]) {
  return times.toSorted()[0];
}

function t3Boundary(runsOnT3: (id: string) => boolean) {
  // SAFETY: ownership only tests boundary's result for truth; hub/running.ts infers `false` from its default.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- until hub/running.ts types boundary as returning boolean
  return runsOnT3 as (id: string) => false;
}
