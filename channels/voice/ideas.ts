import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checks, open, parseSchedules } from "@hex/hub";
import type { Job, Task } from "@hex/hub";
import { z } from "zod";

import { Changes } from "./changes.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type Idea = {
  id: string;
  status: string;
  title: string;
  topic: string;
  thread: string;
  project: string;
  said: string;
  at: string;
  looking: boolean;
  day: string;
  found: boolean;
  checks: { at: string; news: boolean; finding: string }[];
};

const Json = z.json();
const JobsFile = z.record(z.string(), Json);
const Seen = z.record(z.string(), z.string());
const Paused = z.record(z.string(), JobsFile);

type Jobs = z.infer<typeof JobsFile>;

function readJson<T>(file: string, schema: z.ZodType<T>, empty: T): T {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    return empty;
  }
}

function writeJson(file: string, value: z.infer<typeof Json>) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function dayOfWeeklyCheck(job: Job) {
  const fields = job.cron?.trim().split(/\s+/u) ?? [];
  const [monthDay, month, weekday] = fields.slice(2);

  if (weekday === "*" && monthDay === "*" && month === "*") {
    return "daily";
  }

  return /^[0-7]$/u.test(weekday ?? "") ? (DAYS[Number(weekday) % 7] ?? "") : "";
}

function filled(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

export class Ideas extends Changes {
  private readonly state: string;
  private readonly schedules: string;
  private readonly seenFile: string;
  private readonly pausedFile: string;
  private readonly stops: (() => void)[] = [];

  constructor(state: string) {
    super();
    this.state = state;
    this.schedules = join(dirname(state), "schedules.json");
    this.seenFile = join(state, "voice", "ideas-seen.json");
    this.pausedFile = join(state, "voice", "ideas-paused.json");

    const changed = () => {
      this.changed();
    };

    this.stops.push(
      open(state).watch(changed),
      this.follow(state, "ideas.jsonl"),
      this.follow(dirname(state), "schedules.json"),
    );
  }

  private follow(dir: string, file: string) {
    try {
      const watcher = watch(dir, (_, name) => {
        if (name === file) {
          this.changed();
        }
      });

      return () => {
        watcher.close();
      };
    } catch {
      return () => null;
    }
  }

  close() {
    for (const stop of this.stops) {
      stop();
    }
  }

  private jobs(): Record<string, Job> {
    try {
      return parseSchedules(readFileSync(this.schedules, "utf-8"));
    } catch {
      return {};
    }
  }

  async list(): Promise<Idea[]> {
    return await this.shown(await open(this.state).tasks.list({ status: ["idea"] }));
  }

  async one(id: string): Promise<Idea | undefined> {
    const task = await open(this.state).tasks.get(id);

    return task === null ? undefined : (await this.shown([task]))[0];
  }

  private async shown(tasks: Task[]): Promise<Idea[]> {
    const store = open(this.state);
    const [names, ids] = await Promise.all([store.threads.names(), store.threads.ids()]);
    const jobs = Object.values(this.jobs());
    const seen = readJson(this.seenFile, Seen, {});
    const all = checks(this.state);

    return tasks.map((task) => {
      const found = all
        .filter((check) => check.idea === task.id && filled(check.finding) && !filled(check.error))
        .map((check) => ({ at: check.at, news: check.news === true, finding: check.finding ?? "" }))
        .toReversed();

      const job = jobs.find((each) => each.idea === task.id);
      const owners = task.words.filter((words) => words.who === "owner");

      return {
        id: task.id,
        status: task.status,
        title: task.title,
        topic: names[task.owner] ?? "",
        thread: ids[task.owner] ?? "",
        project: task.project ?? "",
        said: (owners.length > 0 ? owners : task.words).map((words) => words.text).join("\n\n"),
        at: task.at,
        looking: job !== undefined,
        day: job === undefined ? "" : dayOfWeeklyCheck(job),
        found: found.some((check) => check.news && check.at > (seen[task.id] ?? "")),
        checks: found,
      };
    });
  }

  async get(id: string) {
    const task = await open(this.state).tasks.get(id);

    if (task === null || task.status === "done") {
      throw new Error(`${id} isn't an idea`);
    }

    return task;
  }

  seen(id: string) {
    writeJson(this.seenFile, {
      ...readJson(this.seenFile, Seen, {}),
      [id]: new Date().toISOString(),
    });

    this.changed();
  }

  async status(id: string, status: "open" | "idea" | "dropped") {
    const was = (await this.get(id)).status;
    await open(this.state).tasks.edit(id, { status });

    return was;
  }

  async stop(id: string) {
    await this.get(id);
    const all = this.raw();
    const names = Object.keys(this.jobs()).filter((name) => this.jobs()[name]?.idea === id);

    if (names.length === 0) {
      return;
    }

    const taken = Object.fromEntries(names.map((name) => [name, all[name] ?? null]));
    this.writeSchedules(
      Object.fromEntries(Object.entries(all).filter(([name]) => !names.includes(name))),
    );
    writeJson(this.pausedFile, { ...readJson(this.pausedFile, Paused, {}), [id]: taken });
  }

  async look(id: string, weekday: number) {
    const task = await this.get(id);

    if (Object.values(this.jobs()).some((job) => job.idea === id)) {
      return;
    }

    const paused = readJson(this.pausedFile, Paused, {});

    const back = paused[id] ?? {
      [`idea-${id}`]: {
        cron: `0 9 * * ${Math.trunc(weekday) % 7}`,
        idea: id,
        prompt: `What's new on this idea: ${task.title}`,
      },
    };

    this.writeSchedules({ ...this.raw(), ...back });
    writeJson(
      this.pausedFile,
      Object.fromEntries(Object.entries(paused).filter(([idea]) => idea !== id)),
    );
  }

  private raw(): Jobs {
    return existsSync(this.schedules)
      ? JobsFile.parse(JSON.parse(readFileSync(this.schedules, "utf-8")))
      : {};
  }

  private writeSchedules(all: Jobs) {
    parseSchedules(JSON.stringify(all));
    writeJson(this.schedules, all);
    this.changed();
  }
}
