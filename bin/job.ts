#!/usr/bin/env bun
import {
  existsSync,
  fstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { saved } from "../hub/claude.ts";
import { served } from "../hub/running.ts";
import { open, stateDir } from "../hub/store.ts";

const [mode, ...rest] = process.argv.slice(2);
const store = open(stateDir());
const records = join(stateDir(), "jobs");

const WhatAJobNeedsToRunAgain = z.object({
  owner: z.string(),
  cwd: z.string(),
  properties: z.array(z.string()),
  command: z.array(z.string()),
  session: z.string().optional(),
});

type Kept = z.infer<typeof WhatAJobNeedsToRunAgain>;

const LINES_OF_OUTPUT = 40;
const CHARACTERS_OF_OUTPUT = 4000;

const isSet = (value?: string): value is string => value !== undefined && value !== "";

const momentASocketGetsToStartSinceNodeParentsLikeClaudeCodesBashLeaveItOpenAndSilent = 1000;

async function stdinThatEnds(): Promise<string> {
  const stdin = fstatSync(0);

  if (stdin.isFIFO() || stdin.isFile()) {
    return await Bun.stdin.text();
  }

  if (!stdin.isSocket()) {
    return "";
  }

  const reader = Bun.stdin.stream().getReader();

  const first = await Promise.race([
    reader.read(),
    Bun.sleep(momentASocketGetsToStartSinceNodeParentsLikeClaudeCodesBashLeaveItOpenAndSilent),
  ]);

  if (first === undefined) {
    await reader.cancel();

    return "";
  }

  const chunks = [];

  for (let read = first; !read.done; read = await reader.read()) {
    chunks.push(read.value);
  }

  return Buffer.concat(chunks).toString();
}

function openThreadIdByKeyOrId(word: string): string | undefined {
  const key = store.threads.key(word);
  const found = store.threads.list({ open: true }).find(({ thread }) => thread === key);

  return found && `${found.app}:${key}`;
}

function tell(unit: string, owner: string, said: string, at: string) {
  store.messages.deliver({
    key: `job:${unit}@${at}`,
    to: owner.slice(owner.indexOf(":") + 1),
    from: "job",
    author: "prompt",
    body: `[job] ${unit} ${said}`,
    meta: { user: "job" },
  });
}

if (mode === "--ended") {
  const [unit = "", owner = ""] = rest;
  const hexMovingToAnotherMachine = existsSync(join(stateDir(), "moving"));

  const keepTheRecordToResumeWhereverHexStartsNext =
    hexMovingToAnotherMachine ||
    (await $`systemctl is-system-running`.nothrow().text()).trim() === "stopping";

  if (keepTheRecordToResumeWhereverHexStartsNext) {
    process.exit(0);
  }

  const record = join(records, `${unit}.json`);

  const session = existsSync(record)
    ? WhatAJobNeedsToRunAgain.safeParse(JSON.parse(readFileSync(record, "utf-8"))).data?.session
    : undefined;

  rmSync(record, { force: true });

  const key = owner.slice(owner.indexOf(":") + 1);

  if (!store.threads.list().some(({ thread }) => thread === key)) {
    console.error(
      `job: ${unit} ended, but no app has the thread ${owner} yet; its end waits there`,
    );
  }

  const result = process.env.SERVICE_RESULT ?? "unknown";
  const status = process.env.EXIT_STATUS ?? "?";

  const invocation = process.env.INVOCATION_ID;
  const output = isSet(invocation) ? await lastOutput(invocation) : "";

  const printed = isSet(output)
    ? `\nWhat it printed last:\n<output>\n${output}\n</output>`
    : " It printed nothing.";

  const check = isSet(session)
    ? `\nThat's the agent's own report, and its whole conversation is in \`${join(import.meta.dir, "hex")} log -- ${session}\`. Check what it says against the real thing (files, commits, links, what's live) before you pass any of it on.`
    : "\nCheck what it shows against the real thing before you report it.";

  tell(
    unit,
    owner,
    `ended: ${result} (exit ${status}).${printed}${check}`,
    invocation ?? `${Date.now()}`,
  );
} else if (mode === "--waiting") {
  const [unit = "", owner = "", readings = ""] = rest;

  tell(
    unit,
    owner,
    `waits for room: no machine has a free slot and room right now. It starts by itself once one does.${readings}`,
    `${process.env.INVOCATION_ID ?? Date.now()}:waiting`,
  );
} else if (mode === "--tell") {
  const [unit = "", owner = "", said = ""] = rest;

  tell(unit, owner, said, `${process.env.INVOCATION_ID ?? Date.now()}:${Bun.hash(said)}`);
} else if (mode === "--resume") {
  const booted = (await $`uptime -s`.nothrow().text()).trim();

  for (const file of readdir(records)) {
    const recorded = file.slice(0, -".json".length);

    if ((await $`systemctl --user is-active --quiet ${recorded}`.nothrow()).exitCode === 0) {
      continue;
    }

    const kept = WhatAJobNeedsToRunAgain.parse(
      JSON.parse(readFileSync(join(records, file), "utf-8")),
    );

    rmSync(join(records, file));

    if (isSet(kept.session) && saved(kept.session)) {
      const prompt = `The machine this job runs on went down (it came back up at ${booted}) and stopped you in the middle of your work. This is the same conversation; anything you had running, like background shells or agents, is gone. Check what's already done, then carry on to the end of your task.`;

      await launch(recorded, kept, [
        ...flags(kept.command.slice(1)),
        "--resume",
        kept.session,
        prompt,
      ]);
      tell(
        recorded,
        kept.owner,
        `stopped when the machine went down, and resumed its own conversation as it came back up (${booted}).`,
        `${booted}:resumed`,
      );
    } else {
      tell(
        recorded,
        kept.owner,
        `stopped when the machine went down, and hasn't run since (it came back up at ${booted}). Start it again if its work still needs doing: ${kept.command.join(" ")}`,
        `${booted}:stopped`,
      );
    }
  }
} else {
  const given = rest.length > 1 ? openThreadIdByKeyOrId(rest[0] ?? "") : undefined;
  const jobOwner = given ?? served();
  const after = given === undefined ? rest : rest.slice(1);
  const [first = "", ...afterFirst] = after;
  const task = after.length > 1 && /^t-\d+$/u.test(first) ? first : undefined;
  const command = task === undefined ? after : afterFirst;
  const [program = ""] = command;

  if (!isSet(mode) || command.length === 0) {
    console.error("usage: job <unit> [<thread>] [<task>] <command...>");
    process.exit(2);
  }

  if (!isSet(jobOwner)) {
    console.error("job: run it from a hex session, or name the thread that owns it");
    process.exit(2);
  }

  const agent = basename(program) === "claude";

  if (!agent && /(^|[\s;&|(/])claude(\s|$)/u.test(command.join(" "))) {
    console.error(
      `job: to run Claude as a hex session, start it from its folder as: job ${mode} claude -p "<prompt>"`,
    );
  }

  const chosen = command.includes("--session-id")
    ? command[command.indexOf("--session-id") + 1]
    : undefined;

  const ownIdToResumeBy =
    agent && !command.some((arg) => /^(--resume|-r|--continue|-c)$/u.test(arg))
      ? (chosen ?? crypto.randomUUID())
      : undefined;

  if (isSet(ownIdToResumeBy) && task !== undefined) {
    store.tasks.addAgents(task, [ownIdToResumeBy]);
  } else if (task !== undefined) {
    console.error(`job: only a claude job's session can be linked to ${task}`);
  }

  const stdinAfterThePromptAsClaudePReadsIt = agent ? await stdinThatEnds() : "";

  const input = isSet(stdinAfterThePromptAsClaudePReadsIt)
    ? [
        "-p",
        `StandardInputData=${Buffer.from(stdinAfterThePromptAsClaudePReadsIt).toString("base64")}`,
      ]
    : [];

  const startedInThread = served({
    HEX_CHANNEL: process.env.HEX_CHANNEL,
    HEX_THREAD: process.env.HEX_THREAD,
  });

  const conversationThatStartedIt = isSet(startedInThread)
    ? { HEX_FROM: startedInThread, HEX_FROM_AT: new Date().toISOString() }
    : { HEX_FROM: process.env.HEX_FROM, HEX_FROM_AT: process.env.HEX_FROM_AT };

  const passed = (name: string, value?: string) => (isSet(value) ? ["-E", `${name}=${value}`] : []);

  const env = [
    ...["PATH", "CLAUDE_CONFIG_DIR"].flatMap((name) => passed(name, process.env[name])),
    ...Object.entries(conversationThatStartedIt).flatMap(([name, value]) => passed(name, value)),
  ];

  const kept: Kept = {
    owner: jobOwner,
    cwd: process.cwd(),
    properties: env,
    command,
  };

  if (ownIdToResumeBy !== undefined) {
    kept.session = ownIdToResumeBy;
  }

  await launch(
    mode,
    kept,
    [
      ...(isSet(ownIdToResumeBy) ? ["--session-id", ownIdToResumeBy] : []),
      ...command
        .slice(1)
        .filter((arg, at, args) => arg !== "--session-id" && args[at - 1] !== "--session-id"),
    ],
    input,
  );
}

async function lastOutput(invocation: string) {
  const lines =
    await $`journalctl --user _SYSTEMD_INVOCATION_ID=${invocation} -o cat --no-pager -n ${LINES_OF_OUTPUT}`
      .nothrow()
      .quiet()
      .text();

  return lines.trim().slice(-CHARACTERS_OF_OUTPUT);
}

function readdir(dir: string) {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

function flags(args: string[]) {
  const theOnlyFlagsWithoutAValue =
    /^(-p|--print|--verbose|--dangerously-skip-permissions|--fork-session)$/u;

  const kept: string[] = [];

  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";

    if (!arg.startsWith("-")) {
      continue;
    }

    if (arg === "--session-id") {
      at++;
    } else if (theOnlyFlagsWithoutAValue.test(arg) || arg.includes("=")) {
      kept.push(arg);
    } else {
      at++;
      kept.push(arg, args[at] ?? "");
    }
  }

  return kept;
}

async function launch(unit: string, kept: Kept, args: string[], input: string[] = []) {
  if ((await $`systemctl --user is-active --quiet ${unit}`.nothrow()).exitCode === 0) {
    console.error(`job: ${unit} already runs`);
    process.exit(1);
  }

  mkdirSync(records, { recursive: true });

  const keptBeforeItsUnitStartsSinceAShortJobCanEndBeforeSystemdRunReturns = join(
    records,
    `${unit}.json`,
  );

  const record = keptBeforeItsUnitStartsSinceAShortJobCanEndBeforeSystemdRunReturns;

  writeFileSync(record, JSON.stringify(kept));

  const agent = basename(kept.command[0] ?? "") === "claude";
  const name = `${store.threads.names()[store.threads.key(kept.owner)] ?? store.threads.key(kept.owner)}/${unit}`;
  const run = agent ? [`${import.meta.dir}/place`, name, ...args] : kept.command;
  const roomToStopItsThreadOnAnotherMachineFirst = agent ? ["-p", "TimeoutStopSec=90s"] : [];
  const givesWayToTheAgentsLikeWhatTheyRun = agent ? [] : ["-p", "Nice=10"];

  const started =
    await $`systemd-run --user --unit=${unit} --slice=hex-jobs.slice --working-directory=${kept.cwd} ${input} ${roomToStopItsThreadOnAnotherMachineFirst} ${givesWayToTheAgentsLikeWhatTheyRun} --collect ${kept.properties} -E CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 -E HEX_OWNER=${kept.owner} -E CLAUDE_CODE_SESSION_NAME=${name} -p ${verbatimPastSystemdsVariableExpansion(`ExecStopPost=${process.execPath} ${join(import.meta.dir, "job")} --ended ${unit} ${kept.owner}`)} -- ${run.map(verbatimPastSystemdsVariableExpansion)}`.nothrow();

  if (started.exitCode === 0) {
    return;
  }

  rmSync(record, { force: true });
  process.exit(started.exitCode);
}

function verbatimPastSystemdsVariableExpansion(arg: string) {
  return arg.replaceAll("$", () => "$$");
}
