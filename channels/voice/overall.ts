import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import { busy, CLAUDE } from "../../hub/running.ts";
import type { Session } from "../../hub/running.ts";
import type { Run } from "./board.ts";
import { clip } from "./questions.ts";
import type { Question } from "./questions.ts";

// A bin/job unit running now: its name, the thread it's for (<app>:<key>), when it started, and
// whether a Claude Code session in it is at work here.
export type Job = { unit: string; owner: string; since: number; working: boolean };

const SHOWN = 8;

// Every bin/job unit running now, found as `hex status` finds them: a user service whose stop
// runs bin/job --ended, which names the unit's thread.
export async function jobs(cgroups = "/sys/fs/cgroup", claude = CLAUDE): Promise<Job[]> {
  const job = join(import.meta.dir, "..", "..", "bin", "job");

  const units = (
    await systemctl("list-units", "--type=service", "--state=running", "--no-legend", "--plain")
  )
    .split("\n")
    .map((line) => line.split(/\s/)[0]!)
    .filter(Boolean);

  const shown = units.length
    ? await systemctl("show", ...units, "-p", "Id,ActiveEnterTimestamp,ExecStopPost,ControlGroup")
    : "";

  return jobsOf(shown, real(job), (group) => busyIn(join(cgroups, group), claude));
}

export function jobsOf(shown: string, job: string, working = (_group: string) => false): Job[] {
  return shown.split("\n\n").flatMap((unit) => {
    const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(unit)?.[1] ?? "";
    const stop = field("ExecStopPost");
    const mark = ` ${job} --ended `;
    const at = stop.indexOf(mark);
    const [name, owner] = at === -1 ? [] : stop.slice(at + mark.length).split(" ");
    const group = field("ControlGroup");

    return name && owner
      ? [
          {
            unit: name,
            owner,
            since: Date.parse(field("ActiveEnterTimestamp")) || 0,
            working: !!group && working(group),
          },
        ]
      : [];
  });
}

// Whether any process in a cgroup is a busy Claude Code session, by the record it keeps (sessions/<pid>.json).
function busyIn(group: string, claude: string) {
  return read(join(group, "cgroup.procs"))
    .split("\n")
    .some((pid) => pid && busy(record(join(claude, "sessions", `${pid}.json`))));
}

// Everything hex runs, as the call says it: what waits on the caller (threads blocked on them, and
// the questions hex keeps for them that no such thread asked), then each thread at work with its
// newest step and the agents working for it, each job no session at work on the board runs for, and
// busy sessions no thread holds. The call's own thread counts only for the agents it runs.
export function overall(
  runs: Run[],
  strays: Session[],
  jobs: Job[],
  names: Record<string, string>,
  now = Date.now(),
  asks: Pick<Question, "task" | "question">[] = [],
) {
  // A job is on the board already when a session at work here runs in it, whatever it calls itself,
  // or when a run or agent at work has the name bin/job gave it, <thread>/<unit>, all a T3 Code thread
  // on another machine keeps of it. One that has stopped working, but whose run still keeps it among
  // its agents, says nothing of whether the job still runs.
  const shown = new Set(
    runs
      .filter((run) => run.state === "working" || run.state === "needs")
      .flatMap((run) => [
        run.name,
        ...run.agents.filter((agent) => agent.state === "working").map((agent) => agent.label),
      ])
      .concat(strays.flatMap((one) => one.name ?? [])),
  );

  const needs = runs.filter((run) => run.state === "needs");
  const asked = asks.filter((ask) => !needs.some((run) => run.id === ask.task));

  const lines = [
    ...needs.map(
      (run) =>
        `${place(run)} waits on you${(run.needs ?? run.line) ? `: ${run.needs ?? run.line}` : ""}`,
    ),
    ...(asked.length
      ? [
          `${asked.length === 1 ? "A question waits" : `${asked.length} questions wait`} on you${asked.length === 1 ? "" : ", the first"}: ${clip(asked[0]!.question.replaceAll(/\s+/g, " ").trim(), 140)}`,
        ]
      : []),
    ...runs
      .filter((run) => run.state === "working")
      .flatMap((run) => {
        const agents = run.agents.filter((agent) => agent.state === "working");

        if (run.app === "voice") {
          return agents.length
            ? [`This call's agents: ${agents.map((agent) => agent.label).join(", ")}`]
            : [];
        }
        const line = agents.find((agent) => agent.line)?.line ?? run.line;

        return [
          `${place(run)}, working for ${lasted(Date.parse(run.since), now)}${line ? `: ${line}` : ""}${agents.length ? `; ${agentsOf(agents.map((agent) => agent.label))}` : ""}`,
        ];
      }),
    ...jobs.flatMap((job) => {
      const key = job.owner.slice(job.owner.indexOf(":") + 1);

      if (job.working || shown.has(`${names[key] ?? key}/${job.unit}`)) {
        return [];
      }
      return [
        `The job ${job.unit}${names[key] ? ` for ${names[key]}` : ""}, running for ${lasted(job.since, now)}`,
      ];
    }),
    ...strays.map((one) => {
      const where = one.cwd && basename(one.cwd);

      const what = one.name
        ? `${one.name}, a Claude Code session outside any thread`
        : `A Claude Code session${where ? ` in ${where}` : ""} outside any thread`;

      return `${what}, busy for ${lasted(one.updated ?? one.started, now)}`;
    }),
  ];

  if (!lines.length) {
    return "Nothing is running anywhere in hex right now.";
  }
  const working = runs.filter(
    (run) => run.state === "working" && run.app !== "voice" && run.app !== "claude",
  ).length;

  const waiting = needs.length + asked.length;

  const counts = [
    working && `${count(working, "thread")} working`,
    waiting && `${waiting} waiting on you`,
  ]
    .filter(Boolean)
    .join(", ");

  const more = lines.length > SHOWN ? [`and ${lines.length - SHOWN} more`] : [];

  return [
    `Everything hex is running${counts ? `, ${counts}` : ""}:`,
    ...lines.slice(0, SHOWN).map((line) => `- ${line}`),
    ...more,
  ].join("\n");
}

function place(run: Run) {
  return run.where === run.name || run.app === "claude" ? run.name : `${run.name} (${run.where})`;
}

function agentsOf(labels: string[]) {
  const named = labels.slice(0, 3).join(", ");

  return `${labels.length === 1 ? "an agent" : `${labels.length} agents`}: ${named}${labels.length > 3 ? " and more" : ""}`;
}

// How long since a moment, as said aloud.
export function lasted(since: number, now = Date.now()) {
  if (!since) {
    return "a while";
  }
  const minutes = Math.max(1, Math.round((now - since) / 60_000));
  const hours = Math.round(minutes / 60);

  return minutes < 60
    ? count(minutes, "minute")
    : hours < 48
      ? count(hours, "hour")
      : count(Math.round(hours / 24), "day");
}

function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function read(path: string) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function record(path: string): Session | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Off the event loop, which carries a phone call's audio both ways; with timestamps in UTC, since
// systemctl writes them in the local zone's abbreviation, which Date.parse can't read for most zones (CET, JST).
async function systemctl(...args: string[]) {
  try {
    const run = Bun.spawn(["systemctl", "--user", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TZ: "UTC" },
      timeout: 5000,
    });

    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);

    return code === 0 ? out : "";
  } catch {
    return "";
  }
}
