import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import { CLAUDE } from "@hex/hub";
import type { Session } from "@hex/hub";
import { z } from "zod";

import type { Run } from "./board.ts";
import { clip } from "./questions.ts";
import type { Question } from "./questions.ts";

type AppColonKey = string;

export type Job = { unit: string; owner: AppColonKey; since: number; working: boolean };

const SHOWN = 8;

export async function jobs(cgroups = "/sys/fs/cgroup", claude = CLAUDE): Promise<Job[]> {
  const job = join(real(join(import.meta.dir, "..", "..", "bin")), "job");

  const units = (
    await systemctlInUtcOffTheCallAudiosEventLoop(
      "list-units",
      "--type=service",
      "--state=running",
      "--no-legend",
      "--plain",
    )
  )
    .split("\n")
    .map((line) => line.split(/\s/u)[0] ?? "")
    .filter(Boolean);

  const shown = units.length
    ? await systemctlInUtcOffTheCallAudiosEventLoop(
        "show",
        ...units,
        "-p",
        "Id,ActiveEnterTimestamp,ExecStopPost,ControlGroup",
      )
    : "";

  return jobsOf(shown, job, (group) => busyIn(join(cgroups, group), claude));
}

export function jobsOf(shown: string, job: string, working = (_group: string) => false): Job[] {
  return shown.split("\n\n").flatMap((unit) => {
    const field = (name: string) => new RegExp(`^${name}=(.*)$`, "mu").exec(unit)?.[1] ?? "";
    const stop = field("ExecStopPost");
    const mark = ` ${job} --ended `;
    const at = stop.indexOf(mark);
    const [name, owner] = at === -1 ? [] : stop.slice(at + mark.length).split(" ");
    const group = field("ControlGroup");

    return name !== undefined && name !== "" && owner !== undefined && owner !== ""
      ? [
          {
            unit: name,
            owner,
            since: Date.parse(field("ActiveEnterTimestamp")) || 0,
            working: group !== "" && working(group),
          },
        ]
      : [];
  });
}

const claudeSessionStatus = z.object({ status: z.string() });
const BUSY_STATUSES = new Set(["busy", "shell"]);

function busyIn(group: string, claude: string) {
  return read(join(group, "cgroup.procs"))
    .split("\n")
    .some((pid) => pid !== "" && busySession(join(claude, "sessions", `${pid}.json`)));
}

function busySession(path: string) {
  try {
    const record = claudeSessionStatus.safeParse(JSON.parse(readFileSync(path, "utf-8")));

    return record.success && BUSY_STATUSES.has(record.data.status);
  } catch {
    return false;
  }
}

export function overall(
  runs: Run[],
  strays: Session[],
  units: Job[],
  names: Record<string, string>,
  now = Date.now(),
  asks: Pick<Question, "task" | "question">[] = [],
) {
  const onTheBoardAlready = new Set([
    ...runs.flatMap((run) =>
      run.state === "working" || run.state === "needs"
        ? [
            run.name,
            run.place,
            ...run.agents.filter((agent) => agent.state === "working").map((agent) => agent.label),
          ]
        : [],
    ),
    ...strays.flatMap((one) => one.name ?? []),
  ]);

  const needs = runs.filter((run) => run.state === "needs");
  const asked = asks.filter((ask) => !needs.some((run) => run.id === ask.task));
  const [firstAsked] = asked;

  const lines = [
    ...needs.map(
      (run) =>
        `${place(run)} waits on you${(run.needs ?? run.line) ? `: ${run.needs ?? run.line}` : ""}`,
    ),
    ...(firstAsked
      ? [
          `${asked.length === 1 ? "A question waits" : `${asked.length} questions wait`} on you${asked.length === 1 ? "" : ", the first"}: ${clip(firstAsked.question.replaceAll(/\s+/gu, " ").trim(), 140)}`,
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

        const line =
          agents.find((agent) => agent.line !== undefined && agent.line !== "")?.line ?? run.line;

        return [
          `${place(run)}, working for ${lasted(Date.parse(run.since), now)}${line ? `: ${line}` : ""}${agents.length ? `; ${agentsOf(agents.map((agent) => agent.label))}` : ""}`,
        ];
      }),
    ...units.flatMap((job) => {
      const key = job.owner.slice(job.owner.indexOf(":") + 1);

      const name = names[key];

      if (job.working || onTheBoardAlready.has(`${name ?? key}/${job.unit}`)) {
        return [];
      }

      return [
        `The job ${job.unit}${name !== undefined && name !== "" ? ` for ${name}` : ""}, running for ${lasted(job.since, now)}`,
      ];
    }),
    ...strays.map((one) => {
      const where = one.cwd === undefined ? "" : basename(one.cwd);

      const what =
        one.name !== undefined && one.name !== ""
          ? `${one.name}, a Claude Code session outside any thread`
          : `A Claude Code session${where === "" ? "" : ` in ${where}`} outside any thread`;

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
  const own = run.place === run.name ? run.name : `${run.place}, part of ${run.name}`;

  return run.where === run.name || run.app === "claude" ? own : `${own} (${run.where})`;
}

function agentsOf(labels: string[]) {
  const named = labels.slice(0, 3).join(", ");

  return `${labels.length === 1 ? "an agent" : `${labels.length} agents`}: ${named}${labels.length > 3 ? " and more" : ""}`;
}

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

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function systemctlInUtcOffTheCallAudiosEventLoop(...args: string[]) {
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
