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
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { besideOf, besideWhat } from "../hub/beside.ts";
import { saved } from "../hub/claude.ts";
import { origin } from "../hub/origin.ts";
import { served } from "../hub/running.ts";
import { hexDir, open, stateDir } from "../hub/store.ts";
import { zoneOf } from "../hub/zone.ts";

const [mode, ...rest] = process.argv.slice(2);
const store = open(stateDir());
const records = join(stateDir(), "jobs");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Names the machine hex runs on while it runs on another one, for this machine's jobs to reach it: whatever moved hex there writes it once hex serves there, and removes it as it brings hex back.
const whereHexRuns = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
  "hex/elsewhere",
);

const HOW_LONG_A_MOVE_IS_WAITED_FOR_MS = 60_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A machine that doesn't answer may only be cut off for a moment, with its jobs still running: only whatever moved hex away from it, which watched it go, names it here, one machine a line, for the next resume to carry its jobs on.
const machinesGone = join(whereHexRuns, "../gone");

async function whereHexIs() {
  for (let waited = 0; existsSync(whereHexRuns); waited += 500) {
    const named = readFileSync(whereHexRuns, "utf-8").trim();

    if (isSet(named)) {
      return named;
    }

    if (waited >= HOW_LONG_A_MOVE_IS_WAITED_FOR_MS) {
      return "moving";
    }

    await Bun.sleep(500);
  }

  return "here";
}

const TRIES_BEFORE_A_MACHINE_COUNTS_AS_GONE = 3;
const STOPPING_SETTLES_WITHIN_MS = 15_000;
const SSH_CANT_REACH_IT = 255;

async function onMachine(machine: string, command: string[], input = "") {
  const words = Buffer.from(command.join("\0")).toString("base64");

  for (let tried = 1; ; tried++) {
    const asked = Bun.spawnSync(
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        machine,
        `bash -c 'mapfile -d "" -t a < <(printf %s ${words} | base64 -d); exec "\${a[@]}"'`,
      ],
      { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );

    if (asked.exitCode !== SSH_CANT_REACH_IT || tried === TRIES_BEFORE_A_MACHINE_COUNTS_AS_GONE) {
      return asked;
    }

    await Bun.sleep(2000);
  }
}

const WhatAJobNeedsToRunAgain = z.object({
  owner: z.string(),
  cwd: z.string(),
  properties: z.array(z.string()),
  command: z.array(z.string()),
  session: z.string().optional(),
  input: z.array(z.string()).optional(),
  machine: z.string().optional(),
  started: z.string().optional(),
  startedOver: z.array(z.string()).optional(),
});

const StoppedBecause = z.enum(["moved", "shutdown", "ended", ""]);

type Kept = z.infer<typeof WhatAJobNeedsToRunAgain>;

const LINES_OF_OUTPUT = 40;
const STARTS_OVER_THAT_MEAN_IT_STOPS_ITSELF = 3;
const WITHIN_MS = 60 * 60 * 1000;
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
const News = z.object({
  unit: z.string(),
  owner: z.string(),
  said: z.string(),
  at: z.string(),
  from: z.array(z.string()),
});

const startedBy = () =>
  ["HEX_FROM", "HEX_FROM_AT"].flatMap((name) =>
    isSet(process.env[name]) ? [`${name}=${process.env[name]}`] : [],
  );

async function tell(unit: string, owner: string, said: string, at: string) {
  const there = await whereHexIs();

  if (there !== "here") {
    const sent =
      there === "moving"
        ? undefined
        : await onMachine(there, [
            "env",
            ...startedBy(),
            join(import.meta.dir, "job"),
            "--tell",
            unit,
            owner,
            said,
            at,
          ]);

    if (sent?.exitCode === 0) {
      return;
    }

    writeFileSync(
      join(records, `${unit}@${Bun.hash(at)}.news`),
      JSON.stringify({ unit, owner, said, at, from: startedBy() }),
    );
    console.error(
      `job: ${unit}'s news waits in ${records} for hex to start somewhere: ${sent?.stderr.toString().trim() ?? "hex is still moving"}`,
    );

    return;
  }

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
    meta: { user: "job", job: unit },
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

  const stopAsked =
    (await $`systemctl --user show -p Job --value ${unit}`.nothrow().text()).trim() !== "";

  const finishedByItself =
    process.env.EXIT_CODE === "exited" && process.env.EXIT_STATUS === "0" && !stopAsked;

  const stopped = finishedByItself
    ? "ended"
    : existsSync(join(stateDir(), "moving"))
      ? "moved"
      : (await $`systemctl is-system-running`.nothrow().text()).trim() === "stopping"
        ? "shutdown"
        : "ended";

  store.seen.show(`job:${unit}`, "stopped", stopped);

  if (stopped !== "ended") {
    process.exit(0);
  }

  const ended = keptRecord(unit);

  if (isSet(ended?.started)) {
    writeFileSync(join(records, `${unit}.ended`), ended.started);
  }

  const session = ended?.session ?? "";

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

  await tell(
    unit,
    owner,
    `ended: ${result} (exit ${status}).\n${output}\n${check}`,
    process.env.INVOCATION_ID ?? `${Date.now()}`,
  );
} else if (mode === "--waiting") {
  const [unit = "", owner = "", readings = ""] = rest;

  await tell(
    unit,
    owner,
    `waits for room: no machine has a free slot and room right now. It starts by itself once one does.${readings}`,
    `${process.env.INVOCATION_ID ?? Date.now()}:waiting`,
  );
} else if (mode === "--tell") {
  const [unit = "", owner = "", said = "", at] = rest;

  await tell(
    unit,
    owner,
    said,
    at ?? `${process.env.INVOCATION_ID ?? Date.now()}:${Bun.hash(said)}`,
  );
} else if (mode === "--running") {
  for (const unit of rest) {
    let state = (await $`systemctl --user is-active ${unit}`.nothrow().text()).trim();

    for (
      let waited = 0;
      state === "deactivating" && waited < STOPPING_SETTLES_WITHIN_MS;
      waited += 500
    ) {
      await Bun.sleep(500);
      state = (await $`systemctl --user is-active ${unit}`.nothrow().text()).trim();
    }

    if (["active", "activating", "deactivating", "reloading"].includes(state)) {
      console.log(`active ${unit}`);
    } else if (!existsSync(join(records, `${unit}.json`))) {
      console.log(`gone ${unit}`);
    }
  }
} else if (mode === "--resume") {
  const gone = new Set(
    existsSync(machinesGone) ? readFileSync(machinesGone, "utf-8").split("\n").filter(isSet) : [],
  );

  rmSync(machinesGone, { force: true });

  const here = hostname();
  const at = new Date().toISOString();
  const zone = zoneOf(hexDir());

  const when = (time: string) =>
    new Date(time).toLocaleString("en-US", {
      timeZone: zone,
      timeZoneName: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  for (const file of existsSync(records)
    ? readdirSync(records).filter((name) => name.endsWith(".news"))
    : []) {
    const news = keptNews(join(records, file));

    rmSync(join(records, file));

    if (news !== undefined) {
      const { unit, owner, said, at: sentAt, from } = news;

      const before = { HEX_FROM: process.env.HEX_FROM, HEX_FROM_AT: process.env.HEX_FROM_AT };
      delete process.env.HEX_FROM;
      delete process.env.HEX_FROM_AT;

      for (const pair of from) {
        const [name = "", ...value] = pair.split("=");
        process.env[name] = value.join("=");
      }

      await tell(unit, owner, said, sentAt);

      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
  }

  const files = readdir(records).filter((name) => !name.includes(".sync-conflict-"));

  const elsewhereNow = await stillOnTheirMachines(
    files.map((file) => file.slice(0, -".json".length)),
    here,
  );

  for (const file of files) {
    const recorded = file.slice(0, -".json".length);

    if ((await $`systemctl --user is-active --quiet ${recorded}`.nothrow()).exitCode === 0) {
      continue;
    }

    const kept = keptRecord(recorded);

    if (kept === undefined) {
      console.error(`job: ${file} can't be read, so ${recorded} isn't started again`);
      continue;
    }

    const endedFile = join(records, `${recorded}.ended`);

    if (
      isSet(kept.started) &&
      existsSync(endedFile) &&
      readFileSync(endedFile, "utf-8") === kept.started
    ) {
      rmSync(join(records, file), { force: true });
      continue;
    }

    const there = elsewhereNow.get(recorded);

    if (there === "active") {
      continue;
    }

    if (there === "down" && !gone.has(kept.machine ?? "")) {
      console.error(
        `job: ${kept.machine} doesn't answer, so ${recorded} is left to it until it's known to be gone`,
      );
      continue;
    }

    if (there === "gone") {
      rmSync(join(records, file), { force: true });
      continue;
    }

    rmSync(join(records, file));

    const stop = store.seen.getWithTime(`job:${recorded}`, "stopped");
    const mark = StoppedBecause.catch("").parse(stop?.record);
    const then = stop === null || mark === "" ? "" : ` at ${when(stop.at)}`;

    store.seen.unshow(`job:${recorded}`, "stopped");

    if (mark === "ended") {
      continue;
    }

    const ranOn = kept.machine ?? "the machine";

    const fromElsewhere = isSet(kept.machine) && kept.machine !== here;

    const moved = mark === "moved" || (mark === "" && fromElsewhere && there !== "down");

    const why = moved
      ? `hex moved${isSet(kept.machine) && kept.machine !== here ? ` from ${kept.machine}` : ""} to ${here}${then}`
      : mark === "shutdown"
        ? `${ranOn} shut down${then}`
        : `${ranOn} went down`;

    const where = moved ? "there" : `as hex started again on ${here} at ${when(at)}`;

    const resumes = valueAfter(kept.command, /^(--resume|-r)$/u);
    const forks = kept.command.includes("--fork-session");
    const continues = kept.command.some((arg) => /^(--continue|-c)$/u.test(arg));
    const session = kept.session ?? (forks ? undefined : resumes);
    const agent = basename(kept.command[0] ?? "") === "claude";
    const conversation = agent && isSet(session) && saved(session);
    const command = kept.command.join(" ");

    const startsOver = (kept.startedOver ?? []).filter(
      (time) => Date.parse(at) - Date.parse(time) < WITHIN_MS,
    );

    const leftToItsOwner = conversation
      ? undefined
      : agent && (continues || !isSet(session))
        ? "it would continue the folder's latest conversation, which is another one now"
        : agent && isSet(resumes) && !forks
          ? `the conversation it resumes isn't on ${here}`
          : startsOver.length >= STARTS_OVER_THAT_MEAN_IT_STOPS_ITSELF
            ? `it started over ${startsOver.length} times in the last hour, so it may be what stops it`
            : undefined;

    if (leftToItsOwner !== undefined) {
      await tell(
        recorded,
        kept.owner,
        `stopped because ${why}, and hasn't run since: ${leftToItsOwner}. Start it again if its work still needs doing: ${command}`,
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
          `You were stopped in the middle of your work because ${why}; hex runs on ${here} now (${when(at)}). This is the same conversation; anything you had running, like background shells or agents, is gone. Check what's already done, then carry on to the end of your task.${firstPrompt}`,
        ]
      : undefined;

    const over: Kept = { ...kept, startedOver: [...startsOver, at] };

    if (agent) {
      over.session = crypto.randomUUID();
    }

    const started = await launch(
      recorded,
      conversation ? kept : over,
      args ?? startArgs(over),
      conversation ? [] : (kept.input ?? []),
    );

    const said =
      started === 0
        ? conversation
          ? `carried on in its own conversation ${where}.`
          : `started over from the beginning ${where}: ${command}`
        : `couldn't start again on ${here}. Start it again if its work still needs doing: ${command}`;

    await tell(recorded, kept.owner, `stopped because ${why}, and ${said}`, `${at}:again`);
  }
} else if ((await whereHexIs()) === "here") {
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

  store.seen.unshow(`job:${mode}`, "stopped");
  process.exitCode = await launch(mode, kept, startArgs(kept), input, true);
} else {
  const there = await whereHexIs();

  if (there === "moving") {
    console.error("job: hex is moving between machines; start the job again in a minute");
    process.exit(1);
  }

  const asWhoStartedIt = Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith("HEX_") && isSet(value) ? [`${name}=${value}`] : [],
  );

  const started = await onMachine(
    there,
    [
      "env",
      ...asWhoStartedIt,
      "sh",
      "-c",
      'cd "$1" && shift && exec "$@"',
      "sh",
      process.cwd(),
      join(import.meta.dir, "job"),
      ...(isSet(mode) ? [mode] : []),
      ...rest,
    ],
    await stdinThatEnds(),
  );

  process.stdout.write(started.stdout);
  process.stderr.write(started.stderr);
  process.exit(started.exitCode ?? 1);
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A job left running on the machine hex moved from carries on there, and one that ended there is done: its own machine says which, while it answers. One that doesn't answer went down with it.
async function stillOnTheirMachines(units: string[], here: string) {
  const byMachine = Map.groupBy(
    units.flatMap((unit) => {
      const machine = keptRecord(unit)?.machine;

      return isSet(machine) && machine !== here ? [{ unit, machine }] : [];
    }),
    ({ machine }) => machine,
  );

  const said = new Map<string, "active" | "gone" | "down">();

  for (const [machine, theirs] of byMachine) {
    const asked = await onMachine(machine, [
      join(import.meta.dir, "job"),
      "--running",
      ...theirs.map(({ unit }) => unit),
    ]);

    if (asked.exitCode === SSH_CANT_REACH_IT) {
      for (const { unit } of theirs) {
        said.set(unit, "down");
      }

      continue;
    }

    if (asked.exitCode !== 0) {
      for (const { unit } of theirs) {
        said.set(unit, "active");
      }

      console.error(
        `job: ${machine} couldn't say what still runs there, so its jobs are left to it`,
      );
      continue;
    }

    for (const line of asked.stdout.toString().split("\n")) {
      const [state, unit = ""] = line.split(" ");

      if (state === "active" || state === "gone") {
        said.set(unit, state);
      }
    }
  }

  return said;
}

function keptNews(file: string) {
  const text = readFileSync(file, "utf-8");

  return News.safeParse(text.startsWith("{") ? JSON.parse(text) : undefined).data;
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

  const before = keptRecord(unit)?.machine;

  if (
    fresh &&
    isSet(before) &&
    before !== hostname() &&
    (await stillOnTheirMachines([unit], hostname())).get(unit) === "active"
  ) {
    console.error(`job: ${unit} already runs on ${before}`);
    process.exit(1);
  }

  mkdirSync(records, { recursive: true });
  rmSync(join(records, `${unit}.ended`), { force: true });

  const keptBeforeItsUnitStartsSinceAShortJobCanEndBeforeSystemdRunReturns = join(
    records,
    `${unit}.json`,
  );

  const record = keptBeforeItsUnitStartsSinceAShortJobCanEndBeforeSystemdRunReturns;

  writeFileSync(
    record,
    JSON.stringify({ ...kept, machine: hostname(), started: new Date().toISOString() }),
  );

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
    await $`systemd-run --user --unit=${unit} --slice=hex-jobs.slice --working-directory=${kept.cwd} ${input} ${roomToStopItsThreadOnAnotherMachineFirst} ${givesWayToTheAgentsLikeWhatTheyRun} --collect -p ${`StandardOutput=append:${log}`} -p ${`StandardError=append:${log}`} ${kept.properties} -E CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 -E HEX_OWNER=${kept.owner} -E CLAUDE_CODE_SESSION_NAME=${name} -p ${verbatimPastSystemdsVariableExpansion(`ExecStopPost=${process.execPath} ${join(import.meta.dir, "job")} --ended ${unit} ${kept.owner}`)} -- ${run.map(verbatimPastSystemdsVariableExpansion)}`
      .cwd(existsSync(kept.cwd) ? kept.cwd : process.cwd())
      .nothrow();

  if (started.exitCode !== 0) {
    rmSync(record, { force: true });
  }

  return started.exitCode;
}

function verbatimPastSystemdsVariableExpansion(arg: string) {
  return arg.replaceAll("$", () => "$$");
}
