#!/usr/bin/env bun
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { besideOf, besideWhat } from "../hub/beside.ts";
import { saved } from "../hub/claude.ts";
import { origin } from "../hub/origin.ts";
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
  input: z.array(z.string()).optional(),
});

const StoppedBecause = z.enum(["moved", "shutdown", ""]);

type Kept = z.infer<typeof WhatAJobNeedsToRunAgain>;

const LINES_OF_OUTPUT = 40;
const CHARACTERS_OF_OUTPUT = 4000;
const BYTES_READ_FOR_THE_END = 64 * 1024;
const LOGS_KEPT_FOR_THEIR_THREADS_MS = 7 * 24 * 60 * 60 * 1000;

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a job's news goes: the session beside a thread that started it, which resumes for it; for General's own work, a new session beside General, so its conversation stays the owner's; otherwise the thread that started it.
function reportsTo(): string | undefined {
  const app = process.env.HEX_CHANNEL?.match(/^plugin:([^@]+)/u)?.[1];
  const { HEX_BESIDE, HEX_MAIN, HEX_THREAD } = process.env;

  if (app !== undefined && isSet(HEX_BESIDE)) {
    return `${app}:${HEX_BESIDE}`;
  }

  if (app !== undefined && isSet(HEX_MAIN) && isSet(HEX_THREAD)) {
    return `${app}:${besideOf(HEX_THREAD)}`;
  }

  return served();
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A new session beside General learns from the job where its work came from.
function tell(unit: string, owner: string, said: string, at: string) {
  const to = store.threads.key(owner);

  const from =
    besideWhat(to) === undefined
      ? undefined
      : origin(store, process.env.HEX_FROM, process.env.HEX_FROM_AT);

  store.messages.deliver({
    key: `job:${unit}@${at}`,
    to,
    from: "job",
    author: "prompt",
    body: [`[job] ${unit} ${said}`, from].filter(isSet).join("\n"),
    meta: { user: "job" },
  });
}

function nameOf(owner: string) {
  const key = store.threads.key(owner);

  const ran = store.messages.ranFor(key);
  const thread = besideWhat(key) ?? (ran === null ? undefined : besideWhat(ran.to)) ?? key;

  return store.threads.names()[thread] ?? thread;
}

if (mode === "--owner") {
  console.log(reportsTo() ?? "");
} else if (mode === "--ended") {
  const [unit = "", owner = ""] = rest;

  const stopped = existsSync(join(stateDir(), "moving"))
    ? "moved"
    : (await $`systemctl is-system-running`.nothrow().text()).trim() === "stopping"
      ? "shutdown"
      : undefined;

  if (stopped !== undefined) {
    store.seen.show(`job:${unit}`, "stopped", stopped);
    process.exit(0);
  }

  const session = keptRecord(unit)?.session ?? "";

  rmSync(join(records, `${unit}.json`), { force: true });

  const output = lastOutput(unit);
  const key = store.threads.key(owner);
  const thread = besideWhat(key) ?? key;

  if (!store.messages.took(key) && !store.threads.list().some((each) => each.thread === thread)) {
    console.error(
      `job: ${unit} ended, but no app has the thread ${owner} yet; its end waits there`,
    );
  }

  const result = process.env.SERVICE_RESULT ?? "unknown";
  const status = process.env.EXIT_STATUS ?? "?";

  const check = isSet(session)
    ? `That's the agent's own account, not proof: check what it says against the real thing (files, commits, links, what's live) before you pass any of it on. Its conversation, if it ran here: \`${join(import.meta.dir, "hex")} log -- ${session}\``
    : "Check what it shows against the real thing before you report it.";

  tell(
    unit,
    owner,
    `ended: ${result} (exit ${status}).\n${output}\n${check}`,
    process.env.INVOCATION_ID ?? `${Date.now()}`,
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
  const here = hostname();
  const at = new Date().toISOString();

  for (const file of readdir(records).filter((name) => !name.includes(".sync-conflict-"))) {
    const recorded = file.slice(0, -".json".length);

    if ((await $`systemctl --user is-active --quiet ${recorded}`.nothrow()).exitCode === 0) {
      continue;
    }

    const kept = keptRecord(recorded);

    if (kept === undefined) {
      console.error(`job: ${file} can't be read, so ${recorded} isn't started again`);
      continue;
    }

    rmSync(join(records, file));

    const why = {
      moved: "hex moved to another machine",
      shutdown: "the machine it ran on shut down",
      "": "the machine it ran on went down",
    }[StoppedBecause.catch("").parse(store.seen.get(`job:${recorded}`, "stopped"))];

    store.seen.unshow(`job:${recorded}`, "stopped");

    const resumes = valueAfter(kept.command, /^(--resume|-r)$/u);
    const session = kept.session ?? resumes;
    const conversation = isSet(session) && saved(session);
    const agent = basename(kept.command[0] ?? "") === "claude";
    const command = kept.command.join(" ");

    if (agent && !conversation && !isSet(session)) {
      tell(
        recorded,
        kept.owner,
        `stopped because ${why}, and hasn't run since: it continued the folder's latest conversation, which is another one now. Start it again if its work still needs doing: ${command}`,
        `${at}:again`,
      );
      continue;
    }

    const { flags, prompt } = partsOf(kept.command.slice(1), kept.input);

    const firstPrompt =
      isSet(resumes) && isSet(prompt)
        ? `\n\nThis job started by resuming this conversation with the prompt below; if you hadn't taken it up yet, do it now:\n\n${prompt}`
        : "";

    const args = conversation
      ? [
          ...flags,
          "--resume",
          session ?? "",
          `You were stopped in the middle of your work because ${why}; hex runs on ${here} now. This is the same conversation; anything you had running, like background shells or agents, is gone. Check what's already done, then carry on to the end of your task.${firstPrompt}`,
        ]
      : startArgs(kept);

    const started = await launch(recorded, kept, args, conversation ? [] : (kept.input ?? []));

    const said =
      started === 0
        ? conversation
          ? `carried on in its own conversation as hex started on ${here}.`
          : `started over from the beginning as hex started on ${here}: ${command}`
        : `couldn't start again on ${here}. Start it again if its work still needs doing: ${command}`;

    tell(recorded, kept.owner, `stopped because ${why}, and ${said}`, `${at}:again`);
  }
} else {
  const given = rest.length > 1 ? openThreadIdByKeyOrId(rest[0] ?? "") : undefined;
  const jobOwner = given ?? reportsTo();
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

  const session = agent ? conversationToResumeBy(command) : undefined;

  if (isSet(session) && task !== undefined) {
    store.tasks.addAgents(task, [session]);
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

  const startedInThread = isSet(process.env.HEX_BESIDE)
    ? reportsTo()
    : served({ HEX_CHANNEL: process.env.HEX_CHANNEL, HEX_THREAD: process.env.HEX_THREAD });

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

  if (session !== undefined) {
    kept.session = session;
  }

  if (input.length > 0) {
    kept.input = input;
  }

  process.exitCode = await launch(mode, kept, startArgs(kept), input, true);
}

function conversationToResumeBy(command: string[]) {
  const chosen = valueAfter(command, /^--session-id$/u);
  const resumed = valueAfter(command, /^(--resume|-r)$/u);

  if (isSet(chosen)) {
    return chosen;
  }

  if (command.includes("--fork-session")) {
    return crypto.randomUUID();
  }

  if (isSet(resumed)) {
    return resumed;
  }

  return command.some((arg) => /^(--continue|-c)$/u.test(arg)) ? undefined : crypto.randomUUID();
}

function startArgs({ command, session }: Kept) {
  const args = command
    .slice(1)
    .filter((arg, at, all) => arg !== "--session-id" && all[at - 1] !== "--session-id");

  const itsOwnConversationAlready = valueAfter(command, /^(--resume|-r)$/u) === session;

  return isSet(session) && !itsOwnConversationAlready ? ["--session-id", session, ...args] : args;
}

function valueAfter(args: string[], flag: RegExp) {
  const at = args.findIndex((arg) => flag.test(arg));

  return at === -1 ? undefined : args[at + 1];
}

function keptRecord(unit: string): Kept | undefined {
  try {
    return WhatAJobNeedsToRunAgain.parse(
      JSON.parse(readFileSync(join(records, `${unit}.json`), "utf-8")),
    );
  } catch {
    return undefined;
  }
}

function lastOutput(unit: string) {
  const log = join(records, `${unit}.log`);
  let lines: string[];

  try {
    lines = endOf(log).trimEnd().split("\n").filter(Boolean);
  } catch {
    return "Its output wasn't kept.";
  }

  if (lines.length === 0) {
    return "It printed nothing.";
  }

  const shown = lines.slice(-LINES_OF_OUTPUT);

  while (shown.length > 1 && shown.join("\n").length > CHARACTERS_OF_OUTPUT) {
    shown.shift();
  }

  const text = shown.join("\n").slice(-CHARACTERS_OF_OUTPUT);
  const cut = shown.length < lines.length || text.length < shown.join("\n").length;
  const earlier = cut ? `, all of it in ${log}` : "";

  return `What it printed last${earlier}:\n<output>\n${text}\n</output>`;
}

function endOf(path: string) {
  const fd = openSync(path, "r");

  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, BYTES_READ_FOR_THE_END));
    readSync(fd, bytes, 0, bytes.length, size - bytes.length);

    return bytes.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function pruneOldLogs() {
  for (const file of readdirSync(records).filter((each) => each.endsWith(".log"))) {
    const log = join(records, file);
    const running = existsSync(log.replace(/\.log$/u, ".json"));
    const written = statSync(log, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();

    if (!running && Date.now() - written > LOGS_KEPT_FOR_THEIR_THREADS_MS) {
      rmSync(log, { force: true });
    }
  }
}

function readdir(dir: string) {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

function partsOf(args: string[], input: string[] = []) {
  const theOnlyFlagsWithoutAValue = /^(-p|--print|--verbose|--dangerously-skip-permissions)$/u;
  const whichConversation = /^(--session-id|--resume|-r)$/u;
  const startsAnotherConversation = /^(--fork-session|--continue|-c)$/u;

  const flags: string[] = [];
  const words: string[] = [];

  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";

    if (!arg.startsWith("-")) {
      words.push(arg);
    } else if (whichConversation.test(arg)) {
      at++;
    } else if (startsAnotherConversation.test(arg)) {
      continue;
    } else if (theOnlyFlagsWithoutAValue.test(arg) || arg.includes("=")) {
      flags.push(arg);
    } else {
      at++;
      flags.push(arg, args[at] ?? "");
    }
  }

  const piped = input.find((property) => property.startsWith("StandardInputData="));

  if (piped !== undefined) {
    words.push(Buffer.from(piped.slice("StandardInputData=".length), "base64").toString());
  }

  return { flags, prompt: words.join("\n\n") };
}

async function launch(
  unit: string,
  kept: Kept,
  args: string[],
  input: string[] = [],
  fresh = false,
) {
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

  const log = join(records, `${unit}.log`);

  if (fresh) {
    writeFileSync(log, "");
    pruneOldLogs();
  }

  const agent = basename(kept.command[0] ?? "") === "claude";
  const name = `${nameOf(kept.owner)}/${unit}`;
  const run = agent ? [`${import.meta.dir}/place`, name, ...args] : kept.command;
  const roomToStopItsThreadOnAnotherMachineFirst = agent ? ["-p", "TimeoutStopSec=90s"] : [];
  const givesWayToTheAgentsLikeWhatTheyRun = agent ? [] : ["-p", "Nice=10"];

  const started =
    await $`systemd-run --user --unit=${unit} --slice=hex-jobs.slice --working-directory=${kept.cwd} ${input} ${roomToStopItsThreadOnAnotherMachineFirst} ${givesWayToTheAgentsLikeWhatTheyRun} --collect -p ${`StandardOutput=append:${log}`} -p ${`StandardError=append:${log}`} ${kept.properties} -E CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 -E HEX_OWNER=${kept.owner} -E CLAUDE_CODE_SESSION_NAME=${name} -p ${verbatimPastSystemdsVariableExpansion(`ExecStopPost=${process.execPath} ${join(import.meta.dir, "job")} --ended ${unit} ${kept.owner}`)} -- ${run.map(verbatimPastSystemdsVariableExpansion)}`.nothrow();

  if (started.exitCode !== 0) {
    rmSync(record, { force: true });
  }

  return started.exitCode;
}

function verbatimPastSystemdsVariableExpansion(arg: string) {
  return arg.replaceAll("$", () => "$$");
}
