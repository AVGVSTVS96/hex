import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nextRun, open, parseSchedules, zoneOf } from "@hex/hub";
import type { Job, Task } from "@hex/hub";

import { generalOf, projectOf } from "./activity.ts";
import { home, watchDir } from "./board.ts";
import type { Board } from "./board.ts";
import { Changes, oneAtATime } from "./changes.ts";
import type { Questions } from "./questions.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;

export type GoalState = "working" | "needs" | "unstarted" | "idle" | "done" | "dropped";

export type Goal = {
  id: string;
  title: string;
  group: string;
  topic: string;
  app: string;
  run?: string;
  link?: string;
  state: GoalState;
  line: string;
  ask?: string;
  words: string[];
  doneWhen?: string;
  proof?: string;
  asked: string;
  at?: string;
};

export type Watch = {
  id: string;
  stopped?: true;
  title: string;
  topic: string;
  run?: string;
  every: string;
  next?: string;
  asked: string[];
  does: string;
  runs: { at: string; said: string }[];
};

export type View = { version: number; goals: Goal[]; watching: Watch[] };

type Changed = { task: Task; told: string };

type Undo = { kind: "goal"; status: Task["status"]; proof?: string } | { kind: "watch"; job: Job };

const SCHEDULES = "schedules.json";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* What the owner asked hex for and how far each is, and what hex keeps watch on for them: the
   open tasks and those reached this week, each placed in its project or topic with where it
   stands, and the timed jobs schedules.json names a `watch` for. hex's own housekeeping has no
   `watch`, and an idea's checks belong to the idea. */
export class Goals extends Changes {
  view: View = { version: this.version, goals: [], watching: [] };
  private shown = "";
  private readonly undos = new Map<string, Undo>();
  private readonly stops: (() => void)[] = [];
  private readonly state: string;
  private readonly hexDir: string;
  private readonly board: Board;
  private readonly questions: Questions;
  readonly refresh = oneAtATime("the goals", async () => {
    const [goals, watching] = await Promise.all([this.goals(), this.watching()]);
    const shown = JSON.stringify({ goals, watching });

    if (shown === this.shown) {
      return;
    }

    this.shown = shown;
    this.changed();
    this.view = { version: this.version, goals, watching };
  });

  constructor(state: string, hexDir: string, board: Board, questions: Questions) {
    super();
    this.state = state;
    this.hexDir = hexDir;
    this.board = board;
    this.questions = questions;

    const again = () => {
      void this.refresh();
    };

    this.stops.push(
      board.listen(again),
      questions.listen(again),
      open(state).watch(again),
      watchDir(hexDir, (file) => {
        if (file === null || file === SCHEDULES) {
          again();
        }
      }),
    );
    again();
  }

  close() {
    for (const stop of this.stops) {
      stop();
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* "Not needed" drops a goal, "Not what I asked" opens a reached one again; either tells its
     topic, and Undo puts back what was there. */
  drop(id: string): Promise<Changed> {
    return this.change(
      id,
      "dropped",
      (task) => `Not needed: ${task.title} (${id}). Stop work on it.`,
    );
  }

  reopen(id: string): Promise<Changed> {
    return this.change(
      id,
      "open",
      (task) => `Not what I asked: ${task.title} (${id}) isn't done yet. Pick it up again.`,
    );
  }

  async undo(id: string): Promise<Changed | undefined> {
    const was = this.undos.get(id);

    if (was === undefined) {
      throw new Error(`Nothing to undo on ${id}.`);
    }

    this.undos.delete(id);

    if (was.kind === "watch") {
      this.writeJobs({ ...this.jobs(), [id]: was.job });
      await this.refresh();

      return;
    }

    const store = open(this.state);

    const task = await store.tasks.edit(id, {
      status: was.status,
      ...(was.proof !== undefined && { proof: was.proof }),
    });

    await this.refresh();

    return { task, told: `Undo: ${task.title} (${id}) is back as it was.` };
  }

  async stopWatching(name: string) {
    const jobs = this.jobs();
    const job = jobs[name];

    if (job?.watch === undefined) {
      throw new Error(`hex isn't watching ${name}.`);
    }

    const { [name]: _stopped, ...rest } = jobs;
    this.writeJobs(rest);
    this.undos.set(name, { kind: "watch", job });
    await this.refresh();
  }

  runOf(id: string) {
    return this.view.goals.find((goal) => goal.id === id)?.run;
  }

  private async change(id: string, status: Task["status"], told: (task: Task) => string) {
    const store = open(this.state);
    const before = await store.tasks.get(id);

    if (before === null) {
      throw new Error(`No goal ${id}.`);
    }

    this.undos.set(id, {
      kind: "goal",
      status: before.status,
      ...(before.proof !== undefined && { proof: before.proof }),
    });

    const task = await store.tasks.edit(id, { status });
    await this.refresh();

    return { task, told: told(task) };
  }

  private jobs(): Record<string, Job> {
    try {
      return parseSchedules(readFileSync(join(this.hexDir, SCHEDULES), "utf-8"));
    } catch {
      return {};
    }
  }

  private writeJobs(jobs: Record<string, Job>) {
    writeFileSync(join(this.hexDir, SCHEDULES), `${JSON.stringify(jobs, null, 2)}\n`);
  }

  async goal(id: string): Promise<Goal | undefined> {
    return (await this.goals((task) => task.id === id))[0];
  }

  private async goals(keep = recent()): Promise<Goal[]> {
    const store = open(this.state);

    const [threads, agentTasks, listed] = await Promise.all([
      store.threads.list(),
      store.tasks.agentTasks(),
      store.tasks.list({ status: ["open", "done", "dropped"] }),
    ]);

    const runs = this.board.runs;
    const general = generalOf(threads);
    const asks = this.questions.view.asks;
    const links = Object.entries(agentTasks);
    const tasks = listed.filter(keep);

    const runOf = (task: Task) => {
      const id = home(task, runs);

      return runs.find((run) => run.id === id);
    };

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    /* A topic's question, and its work when no agent says which goal it's for, belong to its newest
       open goal. General and a DM hold unrelated asks, so theirs go to no goal. */
    const newest = new Map<string, string>();

    for (const task of tasks) {
      const run = runOf(task);

      if (
        run &&
        run.where !== "General" &&
        run.where !== "DM" &&
        task.status === "open" &&
        !newest.has(run.id)
      ) {
        newest.set(run.id, task.id);
      }
    }

    return tasks.map((task) => {
      const run = runOf(task);
      const thread = threads.find((row) => row.thread === task.owner);

      const agents =
        run?.agents.filter((agent) =>
          links.some(([key, linked]) => linked.id === task.id && agent.id.startsWith(key)),
        ) ?? [];

      const everWorked = links.some(([, linked]) => linked.id === task.id);
      const focus = run !== undefined && newest.get(run.id) === task.id;
      const ask = focus ? asks.find((question) => question.task === run.id) : undefined;

      const working =
        agents.find((agent) => agent.state === "working") ??
        (focus && run.running ? run : undefined);

      const state: GoalState =
        task.status === "done" || task.status === "dropped"
          ? task.status
          : ask
            ? "needs"
            : working
              ? "working"
              : everWorked || focus
                ? "idle"
                : "unstarted";

      const line =
        state === "done"
          ? (task.proof ?? "")
          : state === "needs"
            ? (ask?.question ?? "")
            : state === "working"
              ? (working?.line ?? "")
              : state === "idle" && run?.state !== "idle"
                ? (run?.line ?? "")
                : "";

      const at =
        state === "done" || state === "dropped"
          ? task.closed
          : state === "needs"
            ? ask?.at
            : state === "unstarted"
              ? undefined
              : run?.at;

      return {
        id: task.id,
        title: task.title,
        group: task.project ?? run?.name ?? (thread ? projectOf(thread, general) : "hex"),
        topic: run?.name ?? thread?.name ?? "",
        app: run?.app ?? thread?.app ?? "",
        ...(run && { run: run.id }),
        ...(run?.link !== undefined && { link: run.link }),
        state,
        line: clip(oneLine(line), 200),
        ...(ask && { ask: ask.id }),
        words: task.words.slice(0, 3).map((said) => clip(said.text, 600)),
        ...(task.doneWhen !== undefined && { doneWhen: task.doneWhen }),
        ...(task.proof !== undefined && { proof: clip(task.proof, 800) }),
        asked: task.at,
        ...(at !== undefined && { at }),
      };
    });
  }

  private async watching(): Promise<Watch[]> {
    const store = open(this.state);
    const zone = zoneOf(this.hexDir);
    const threads = await store.threads.list();
    const now = Math.floor(Date.now() / MINUTE);

    const stopped = [...this.undos].flatMap(([name, undo]) =>
      undo.kind === "watch" ? [[name, undo.job] as const] : [],
    );

    const each = [...Object.entries(this.jobs()), ...stopped].map(async ([name, job]) => {
      if (job.watch === undefined || job.idea !== undefined) {
        return [];
      }

      const off = stopped.some(([one]) => one === name);

      const run = this.board.runs.find((one) => one.thread === job.thread);
      const thread = threads.find((row) => row.thread === job.thread);
      const next = off ? undefined : nextRun(job, zone, now);
      const task = /\bt-\d+\b/u.exec(job.prompt)?.[0];

      const [asked, ran] = await Promise.all([
        task === undefined ? undefined : store.tasks.get(task),
        store.messages.runsOf(name, 6),
      ]);

      return {
        id: name,
        ...(off && { stopped: true as const }),
        title: job.watch,
        topic: run?.name ?? thread?.name ?? "General",
        ...(run && { run: run.id }),
        every: everyOf(job, zone),
        ...(next !== undefined && { next: new Date(next * MINUTE).toISOString() }),
        asked: asked?.words.map((said) => said.text) ?? [],
        does: job.prompt,
        runs: ran.map((one) => ({ at: one.at, said: oneLine(one.said) })),
      };
    });

    return (await Promise.all(each)).flat();
  }
}

const HOURS = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;

const CLOCK = (hour: number, minute: number) =>
  minute === 0
    ? HOURS(hour)
    : `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

function recent() {
  const reached = new Date(Date.now() - 7 * DAY).toISOString();
  const dropped = new Date(Date.now() - DAY).toISOString();

  return (task: Task) =>
    task.status === "open" || (task.closed ?? "") >= (task.status === "done" ? reached : dropped);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How often a job runs, as the owner would say it; a cron these words don't cover is "on a schedule".
export function everyOf(job: Pick<Job, "cron" | "at">, zone?: string): string {
  if (job.cron === undefined) {
    const ats = [job.at ?? []].flat();

    return ats.length === 1 ? `once, ${onceOf(ats[0] ?? "", zone)}` : `${ats.length} times`;
  }

  const [minute = "", hour = "", day = "", month = "", weekday = ""] = job.cron
    .trim()
    .split(/\s+/u);

  const m = Number(minute);
  const h = Number(hour);

  if (!/^\d+$/u.test(minute) || month !== "*") {
    return "on a schedule";
  }

  if (/^\d+$/u.test(hour)) {
    const at = CLOCK(h, m);

    if (day === "*" && weekday === "*") {
      return `every day at ${at}`;
    }

    if (day === "*" && /^\d$/u.test(weekday)) {
      return `every ${WEEKDAYS[Number(weekday)]} at ${at}`;
    }

    if (weekday === "*" && /^[\d,]+$/u.test(day)) {
      return `on day ${day.split(",").join(" and ")} of the month at ${at}`;
    }
  }

  const every = /^\*\/(\d+)$/u.exec(hour);

  if (every && day === "*" && weekday === "*") {
    return `every ${every[1]} hours`;
  }

  const span = /^(\d+)-(\d+)(?:\/(\d+))?$/u.exec(hour);

  if (span && day === "*" && weekday === "*") {
    return `${span[3] === undefined ? "hourly" : `every ${span[3]} hours`}, ${HOURS(Number(span[1]))} to ${HOURS(Number(span[2]))}`;
  }

  if (hour === "*" && day === "*" && weekday === "*") {
    return "hourly";
  }

  return "on a schedule";
}

function onceOf(at: string, zone?: string) {
  const when = Temporal.PlainDateTime.from(at);

  const date = when.toZonedDateTime(zone ?? Temporal.Now.timeZoneId()).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

  return `${date} at ${CLOCK(when.hour, when.minute)}`;
}

function clip(text: string, size: number) {
  return text.length > size ? `${text.slice(0, size - 1).trimEnd()}…` : text;
}

function oneLine(text: string) {
  return text.replaceAll(/\s+/gu, " ").trim();
}
