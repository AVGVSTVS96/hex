import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { besideOf } from "./beside.ts";
import { study } from "./ideas.ts";
import { open } from "./store.ts";
import { zoneOf } from "./zone.ts";

const FIELDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

const PART = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/u;
const AT = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d$/u;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MINUTE = 60_000;

function fits(part: string, [min, max]: readonly [number, number]) {
  const match = PART.exec(part);

  if (!match) {
    return false;
  }

  const [, from = String(min), to = from, step = "1"] = match;

  return Number(from) >= min && Number(to) <= max && Number(from) <= Number(to) && Number(step) > 0;
}

function isCron(cron: string) {
  const fields = cron.trim().split(/\s+/u);

  return (
    fields.length === FIELDS.length &&
    FIELDS.every((bounds, index) =>
      (fields[index] ?? "").split(",").every((part) => fits(part, bounds)),
    )
  );
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
      check: z.boolean({ error: "check must be true or false" }).optional(),
    },
    { error: "prompt is missing" },
  )
  .refine((job) => job.cron !== undefined || job.at !== undefined, {
    error: "it needs a cron or an at",
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

type WallClock = { minute: number; hour: number; day: number; month: number; weekday: number };

const clocks = new Map<string | undefined, Intl.DateTimeFormat>();

function wall(minute: number, zone?: string): WallClock {
  let clock = clocks.get(zone);

  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    clocks.set(zone, clock);
  }

  const part = Object.fromEntries(
    clock.formatToParts(minute * MINUTE).map(({ type, value }) => [type, value]),
  );

  return {
    minute: Number(part.minute),
    hour: Number(part.hour),
    day: Number(part.day),
    month: Number(part.month),
    weekday: DAYS.indexOf(part.weekday ?? ""),
  };
}

function inField(spec: string, [min, max]: readonly [number, number], value: number) {
  return spec.split(",").some((part) => {
    const [range = "", step = "1"] = part.split("/");
    const [from, to] = range.split("-");
    const lo = range === "*" ? min : Number(from);
    const hi = range === "*" || (to === undefined && part.includes("/")) ? max : Number(to ?? from);

    return value >= lo && value <= hi && (value - lo) % Number(step) === 0;
  });
}

function onCron(cron: string, at: WallClock) {
  const [minute = "", hour = "", monthDay = "", month = "", weekDay = ""] = cron
    .trim()
    .split(/\s+/u);

  const onMonthDay = inField(monthDay, FIELDS[2], at.day);

  const onWeekDay =
    inField(weekDay, FIELDS[4], at.weekday) || (at.weekday === 0 && inField(weekDay, FIELDS[4], 7));

  const onDay =
    monthDay !== "*" && weekDay !== "*" ? onMonthDay || onWeekDay : onMonthDay && onWeekDay;

  return (
    onDay &&
    inField(minute, FIELDS[0], at.minute) &&
    inField(hour, FIELDS[1], at.hour) &&
    inField(month, FIELDS[3], at.month)
  );
}

function minuteOf(at: string, zone = Temporal.Now.timeZoneId()) {
  return Temporal.PlainDateTime.from(at).toZonedDateTime(zone).epochMilliseconds / MINUTE;
}

export function check(
  storeDir: string,
  hexDir: string,
  main: string,
  now = Math.floor(Date.now() / MINUTE),
  research = study,
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

    store.messages.deliver({
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

  const cronsLeft = new Map(
    Object.entries(jobs).flatMap(([name, job]) =>
      job.cron === undefined ? [] : [[name, job.cron] as const],
    ),
  );

  for (let minute = now; minute > since && cronsLeft.size > 0; minute--) {
    const at = wall(minute, zone);

    for (const [name, cron] of cronsLeft) {
      if (!onCron(cron, at)) {
        continue;
      }

      cronsLeft.delete(name);
      found(name, minute);
    }
  }

  store.write(() => {
    for (const [name, minute] of slots) {
      const job = jobs[name];

      if (job !== undefined && job.idea === undefined) {
        store.scheduler.fire(
          name,
          minute,
          job.thread === undefined || job.check === true
            ? besideOf(job.thread ?? main)
            : job.thread,
          `[${name}] ${job.prompt}`,
          minute < now,
        );
      }
    }

    store.scheduler.check(now);
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
