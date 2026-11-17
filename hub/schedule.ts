import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { besideOf } from "./beside.ts";
import { study } from "./ideas.ts";
import { running } from "./running.ts";
import type { Session } from "./running.ts";
import { stalled } from "./stalled.ts";
import { open, signalOf } from "./store.ts";
import type { Row, Store } from "./store.ts";
import { zoneOf } from "./zone.ts";

const AT = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d$/u;
const MINUTE = 60_000;

function isCron(cron: string) {
  if (cron.trim().split(/\s+/u).length !== 5) {
    return false;
  }

  try {
    Bun.cron.parse(cron);

    return true;
  } catch {
    return false;
  }
}

function isAt(at: string) {
  if (!AT.test(at)) {
    return false;
  }

  try {
    Temporal.PlainDateTime.from(at);

    return true;
  } catch {
    return false;
  }
}

const notCron = (issue: { input: unknown }) =>
  `${JSON.stringify(issue.input)} is not a five-field cron expression`;

const notAt = 'at must be "YYYY-MM-DD HH:MM", or a list of them';
const notIdea = "idea must be an idea's id, like t-12";
const notOn = 'on must list the signals it runs on, like ["job-failed"]';
const At = z.string().refine(isAt, { error: notAt });

const JobSchema = z
  .object(
    {
      prompt: z.string({ error: "prompt is missing" }).min(1, { error: "prompt is missing" }),
      cron: z.string({ error: notCron }).refine(isCron, { error: notCron }).optional(),
      at: z.union([At, z.array(At)], { error: notAt }).optional(),
      thread: z.string({ error: "thread must be a thread's id" }).optional(),
      idea: z
        .string({ error: notIdea })
        .regex(/^t-\d+$/u, { error: notIdea })
        .optional(),
      on: z.array(z.string().min(1), { error: notOn }).min(1, { error: notOn }).optional(),
      check: z.boolean({ error: "check must be true or false" }).optional(),
      watch: z
        .string({ error: "watch must be the name the owner knows it by" })
        .min(1, { error: "watch must be the name the owner knows it by" })
        .optional(),
    },
    { error: "prompt is missing" },
  )
  .refine((job) => job.cron !== undefined || job.at !== undefined || job.on !== undefined, {
    error: "it needs a cron, an at or an on",
  })
  .refine(
    (job) =>
      job.idea === undefined || job.cron === undefined || /^\d+\s+\d+\s/u.test(job.cron.trim()),
    { error: "an idea's check runs at most daily, so its cron names one minute and one hour" },
  );

export type Job = z.infer<typeof JobSchema>;

export type IdeaJob = Job & { idea: string };

const Jobs = z.record(z.string(), JobSchema);

export function parse(text: string): Record<string, Job> {
  const parsed = Jobs.safeParse(JSON.parse(text));

  if (parsed.success) {
    return parsed.data;
  }

  const [issue] = parsed.error.issues;
  const name = issue?.path[0];

  throw new Error(
    issue === undefined || name === undefined
      ? z.prettifyError(parsed.error)
      : `${String(name)}: ${issue.message}`,
  );
}

function afterMinute(cron: string, from: number, zone = Temporal.Now.timeZoneId()) {
  const next = Bun.cron.parse(cron, from * MINUTE, { tz: zone });

  return next === null ? undefined : next.getTime() / MINUTE;
}

function minuteOf(at: string, zone = Temporal.Now.timeZoneId()) {
  return Temporal.PlainDateTime.from(at).toZonedDateTime(zone).epochMilliseconds / MINUTE;
}

export function nextRun(
  job: Job,
  zone: string | undefined,
  from = Math.floor(Date.now() / MINUTE),
) {
  const nexts = [job.at ?? []]
    .flat()
    .map((at) => minuteOf(at, zone))
    .filter((minute) => minute > from);

  const onCron = job.cron === undefined ? undefined : afterMinute(job.cron, from, zone);

  if (onCron !== undefined) {
    nexts.push(onCron);
  }

  return nexts.length > 0 ? Math.min(...nexts) : undefined;
}

const WHYS_SHOWN = 20;
const WHY_LENGTH = 300;

function whyNow(heard: Row[]) {
  const whys = heard
    .slice(0, WHYS_SHOWN)
    .map((row) => `- ${(row.body.split("\n")[0] ?? "").slice(0, WHY_LENGTH)}`);

  const more = heard.length - WHYS_SHOWN;

  return `\n\nWhy now:\n${whys.join("\n")}${more > 0 ? `\n- and ${more} more` : ""}`;
}

export function check(
  storeDir: string,
  hexDir: string,
  main: string,
  now = Math.floor(Date.now() / MINUTE),
  research = study,
  sessions: (store: Store) => Map<string, Session> = running,
) {
  const store = open(storeDir);
  let text: string;

  try {
    text = readFileSync(join(hexDir, "schedules.json"), "utf-8");
  } catch {
    return;
  }

  let jobs: Record<string, Job>;

  try {
    jobs = parse(text);
  } catch (error) {
    const body = `[schedules] schedules.json no longer loads, so no job runs until it's fixed: ${error instanceof Error ? error.message : String(error)}`;

    void store.messages.deliver({
      key: `schedule:broken@${Bun.hash(text).toString(36)}`,
      to: besideOf(main),
      from: "schedule",
      author: "prompt",
      body,
      meta: { user: "schedule" },
    });

    return;
  }

  const zone = zoneOf(hexDir);
  const since = store.scheduler.checked() ?? now;
  const slots = new Map<string, number>();

  const found = (name: string, minute: number) => {
    if (minute > since && minute <= now && minute > (slots.get(name) ?? -Infinity)) {
      slots.set(name, minute);
    }
  };

  for (const [name, job] of Object.entries(jobs)) {
    for (const at of [job.at ?? []].flat()) {
      found(name, minuteOf(at, zone));
    }
  }

  for (const [name, { cron }] of Object.entries(jobs)) {
    if (cron === undefined) {
      continue;
    }

    for (
      let slot = afterMinute(cron, since, zone);
      slot !== undefined && slot <= now;
      slot = afterMinute(cron, slot, zone)
    ) {
      found(name, slot);
    }
  }

  const alive = sessions(store);
  stalled(store, alive.values(), now * MINUTE);

  const where = (job: Job) =>
    job.thread === undefined || job.check === true ? besideOf(job.thread ?? main) : job.thread;

  void store.write((tx) => {
    const signals = tx.scheduler.signals();

    for (const [name, minute] of slots) {
      const job = jobs[name];

      if (job !== undefined && job.idea === undefined) {
        tx.scheduler.fire(name, minute, where(job), `[${name}] ${job.prompt}`, minute < now);
      }
    }

    const busy = new Set<string>();

    for (const [name, job] of Object.entries(jobs)) {
      const heard = signals.filter((row) => job.on?.includes(signalOf(row.to) ?? "") === true);

      if (heard.length === 0 || job.idea !== undefined) {
        continue;
      }

      if (tx.scheduler.running(name, [...alive.keys()])) {
        for (const row of heard) {
          busy.add(row.key);
        }
      } else {
        tx.scheduler.fireOn(name, heard, where(job), `[${name}] ${job.prompt}${whyNow(heard)}`);
      }
    }

    for (const row of signals) {
      if (!busy.has(row.key)) {
        tx.messages.take(row.key, "schedule");
      }
    }

    tx.scheduler.check(now);
  });

  for (const [name, job] of Object.entries(jobs)) {
    if (job.idea !== undefined) {
      research(storeDir, name, { ...job, idea: job.idea }, main, slots.get(name));
    }
  }
}

export function schedule(storeDir: string, hexDir: string, main: string): () => void {
  let timer: ReturnType<typeof setTimeout>;

  const tick = () => {
    try {
      check(storeDir, hexDir, main);
    } catch (error) {
      process.stderr.write(`hub: the scheduler couldn't check schedules.json: ${String(error)}\n`);
    }

    timer = setTimeout(tick, MINUTE - (Date.now() % MINUTE));
  };

  tick();

  return () => {
    clearTimeout(timer);
  };
}
