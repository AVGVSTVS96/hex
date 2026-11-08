#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

const given = (value?: string) => (value === "" ? undefined : value);
const home = given(process.env.CLAUDE_PROJECT_DIR) ?? resolve(import.meta.dir, "../..");
const hex = join(home, ".hex/bin/hex");
const now = Date.now() / 1000;
const DAY = 24 * 60 * 60;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const Schedules = z.record(
  z.string(),
  z.object({
    at: z.union([z.string(), z.array(z.string())]).optional(),
    cron: z.string().optional(),
  }),
);

const RunningSession = z.object({
  id: z.string(),
  kind: z.string().optional(),
  name: z.string().optional(),
  cwd: z.string().optional(),
  started: z.number().optional(),
  state: z.string().optional(),
  status: z.string().optional(),
});

type Session = z.infer<typeof RunningSession>;

const Thread = z.object({
  thread: z.string(),
  app: z.string(),
  name: z.string(),
  open: z.boolean(),
  session: z.string().nullish(),
});

const Row = z.object({
  to: z.string(),
  from: z.string(),
  author: z.string(),
  body: z.string(),
  at: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// oxlint-disable-next-line typescript/no-misused-spread -- lengths count code points, as the Python version did
const codePoints = (text: string) => [...text];

const first = (text: string, length: number) => codePoints(text).slice(0, length).join("");

const zone = () => Temporal.Now.timeZoneId();

function ago(at: number) {
  const minutes = Math.floor((now - at) / 60);

  return minutes < 60
    ? `${minutes}m ago`
    : minutes < 2880
      ? `${Math.floor(minutes / 60)}h ago`
      : `${Math.floor(minutes / 1440)}d ago`;
}

function clock(when: Temporal.PlainDateTime) {
  const hour = when.hour % 12 || 12;
  const minute = String(when.minute).padStart(2, "0");

  return `${WEEKDAYS[when.dayOfWeek - 1]} ${MONTHS[when.month - 1]} ${when.day} ${hour}:${minute}${when.hour < 12 ? "AM" : "PM"}`;
}

function capped(items: string[], limit: number) {
  return items.length > limit
    ? [...items.slice(0, limit), `- +${items.length - limit} more`]
    : items;
}

function git(...args: string[]) {
  return Bun.spawnSync(["git", "-C", home, ...args], { stderr: "ignore" }).stdout.toString();
}

function hexJson<T>(schema: z.ZodType<T>, ...args: string[]): T {
  const run = Bun.spawnSync([hex, ...args, "--json"], { stderr: "ignore", timeout: 5000 });

  if (!run.success) {
    throw new Error(`hex ${args.join(" ")} failed`);
  }

  return schema.parse(JSON.parse(run.stdout.toString()));
}

function branches() {
  const unmerged = new Set(
    git("branch", "--no-merged", "HEAD", "--format=%(refname:short)").split(/\s+/u).filter(Boolean),
  );

  return git(
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)\t%(committerdate:unix)\t%(subject)",
    "refs/heads",
  )
    .split("\n")
    .filter(Boolean)
    .flatMap((row) => {
      const [name = "", at, subject, ...rest] = row.split("\t");

      if (at === undefined || subject === undefined || rest.length > 0) {
        throw new Error(`a branch row isn't name, date and subject: ${row}`);
      }

      return unmerged.has(name) ? [`- ${name} (${ago(Number(at))}): ${first(subject, 100)}`] : [];
    });
}

const isUpcoming = (when: Temporal.PlainDateTime) =>
  when.toZonedDateTime(zone()).epochMilliseconds / 1000 >= now;

function oneOffs() {
  let jobs: unknown;

  try {
    jobs = JSON.parse(readFileSync(join(home, "schedules.json"), "utf-8"));
  } catch {
    return [];
  }

  const upcoming: [Temporal.PlainDateTime, string][] = [];

  for (const [name, job] of Object.entries(Schedules.parse(jobs))) {
    const at = job.at ?? [];

    for (const when of [at].flat().map((text) => Temporal.PlainDateTime.from(text))) {
      if (isUpcoming(when)) {
        upcoming.push([when, `- ${clock(when)}: ${name}`]);
      }
    }

    const fields = (job.cron ?? "* * * * *").trim().split(/\s+/u);

    if (fields.length !== 5) {
      throw new Error(`${name}: its cron isn't five fields`);
    }

    const [minute = "", hour = "", day = "", month = ""] = fields;

    if (![minute, hour, day, month].every((field) => /^\d+$/u.test(field))) {
      continue;
    }

    let when = new Temporal.PlainDateTime(
      Temporal.Now.plainDateISO().year,
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
    );

    if (!isUpcoming(when)) {
      when = when.with({ year: when.year + 1 }, { overflow: "reject" });
    }

    upcoming.push([when, `- ${clock(when)}: ${name}`]);
  }

  return upcoming
    .toSorted(
      ([a, lineA], [b, lineB]) => Temporal.PlainDateTime.compare(a, b) || byText(lineA, lineB),
    )
    .map(([, line]) => line);
}

let read: { sessions: Session[] } | { error: unknown } | undefined;

function readRunning() {
  try {
    read ??= { sessions: hexJson(z.array(RunningSession), "running") };
  } catch (error) {
    read = { error };
  }

  return read;
}

const stateOf = (session: Session) =>
  session.state === "blocked" ? "blocked" : (session.status ?? "?");

function sessions() {
  const running = readRunning();

  if ("error" in running) {
    throw running.error;
  }

  const byState = new Map<string, string[]>();

  for (const session of running.sessions.toSorted((a, b) => (b.started ?? 0) - (a.started ?? 0))) {
    if (session.kind === "bg" && `${session.cwd ?? ""}/`.startsWith(`${home}/`)) {
      const state = stateOf(session);
      byState.set(state, [
        ...(byState.get(state) ?? []),
        given(session.name) ?? session.id.slice(0, 8),
      ]);
    }
  }

  return [...byState]
    .toSorted(([a], [b]) => byText(a, b))
    .map(
      ([state, names]) =>
        `- ${state} (${names.length}): ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, +${names.length - 8} more` : ""}`,
    );
}

function threads() {
  const running = readRunning();

  const states = new Map(
    ("sessions" in running ? running.sessions : []).map((session) => [
      session.id,
      stateOf(session),
    ]),
  );

  const open = hexJson(z.array(Thread), "threads").filter((thread) => thread.open);

  const sessionOf = new Map(open.map((thread) => [thread.thread, thread.session]));
  const appOf = new Map(open.map((thread) => [thread.thread, thread]));

  const since = Temporal.Instant.fromEpochMilliseconds((now - DAY) * 1000)
    .toZonedDateTimeISO(zone())
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });

  const last = new Map<string, z.infer<typeof Row>>();

  for (const row of hexJson(z.array(Row), "log", "--since", since)) {
    if (!(row.from === "terminal" && row.author === "hex") && !("failed" in (row.meta ?? {}))) {
      last.set(row.to, row);
    }
  }

  return [...last]
    .toSorted(([, a], [, b]) => byText(b.at, a.at))
    .flatMap(([id, { author, body, at }]) => {
      const thread = appOf.get(id);

      if (!thread) {
        return [];
      }

      const said = body.replaceAll(/[*`]/gu, "").split(/\s+/u).filter(Boolean).join(" ");
      const session = sessionOf.get(id);

      const where = [
        thread.app,
        session === undefined || session === null ? undefined : states.get(session),
      ]
        .filter(Boolean)
        .join(", ");

      return [
        `- ${thread.name} (${where}, ${ago(Date.parse(at) / 1000)}) ${author}: ${first(said, 100)}${codePoints(said).length > 100 ? "…" : ""}`,
      ];
    });
}

function section(title: string, lines: () => string[]) {
  try {
    const shown = lines();

    return `\n\n${title}:\n${shown.length > 0 ? shown.join("\n") : "- none"}`;
  } catch {
    return "";
  }
}

await Bun.stdin.text();

const sections = [
  section("Unmerged hex branches, newest first", () => capped(branches(), 8)),
  section("Upcoming one-off jobs in schedules.json", () => capped(oneOffs(), 6)),
  section("hex background sessions running, by state (`hex running`)", sessions),
  section("Threads active in the last day, newest first, with their last message (`hex log`)", () =>
    capped(threads(), 8),
  ),
].join("");

if (sections) {
  console.log(
    `Live status, read just now (${clock(Temporal.Now.plainDateTimeISO())}). It's read from real state every session start; trust it over any stored 'waiting on' note, and recheck the source before acting.${sections}`,
  );
}
