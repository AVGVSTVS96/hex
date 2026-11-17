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
import { hexDir, open, signalTo, stateDir, StopReasonColumn } from "../hub/store.ts";
import type { Job, JobSpec, StopReason } from "../hub/store.ts";
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
const resuming = join(whereHexRuns, "../resuming");

async function whereHexIs(waitOutAMove = HOW_LONG_A_MOVE_IS_WAITED_FOR_MS) {
  for (let waited = 0; existsSync(whereHexRuns); waited += 500) {
    const named = readFileSync(whereHexRuns, "utf-8").trim();

    if (named === hostname()) {
      return "here";
    }

    if (isSet(named)) {
      return named;
    }

    if (waited >= waitOutAMove) {
      return "moving";
    }

    await Bun.sleep(500);
  }

  return "here";
}

const TRIES_BEFORE_A_MACHINE_COUNTS_AS_GONE = 3;
const STOPPING_SETTLES_WITHIN_MS = 15_000;
const SSH_CANT_REACH_IT = 255;
const RUNS_OR_STILL_ENDS = new Set(["active", "activating", "deactivating", "reloading"]);

const stateOf = async (unit: string) =>
  (await $`systemctl --user is-active ${unit}`.nothrow().text()).trim();

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How each job this machine ran last stopped, kept on this machine alone: hex.db hears it from here as the job ends, and asks here when it couldn't.
const outcomes = join(whereHexRuns, "../jobs");

const OutcomeJson = z.object({
  run: z.string(),
  stopped: z.enum(["ended", ...StopReasonColumn.options]),
  at: z.string(),
});

type Outcome = z.infer<typeof OutcomeJson>;

function outcomeOf(unit: string, run?: string): Outcome | undefined {
  try {
    const kept = OutcomeJson.parse(JSON.parse(readFileSync(join(outcomes, unit), "utf-8")));

    const endedBeforeRunsWereKeptButAfterThisOneStarted = kept.run === "" && kept.at >= (run ?? "");

    if (run === undefined || kept.run === run || endedBeforeRunsWereKeptButAfterThisOneStarted) {
      return kept;
    }

    const aLaterRunStartedHereSoThisOneIsOver = kept.run > run;

    return aLaterRunStartedHereSoThisOneIsOver ? { ...kept, stopped: "ended" } : undefined;
  } catch {
    return undefined;
  }
}

type Now =
  | { state: "active" | "ended" | "down" | "unknown" }
  | { state: "stopped"; stop: NonNullable<Job["stopped"]> };

async function nowHere(unit: string, run: string): Promise<Now> {
  if (RUNS_OR_STILL_ENDS.has(await stateOf(unit))) {
    return { state: "active" };
  }

  const outcome = outcomeOf(unit, run);

  if (outcome === undefined) {
    return { state: "unknown" };
  }

  return outcome.stopped === "ended"
    ? { state: "ended" }
    : { state: "stopped", stop: { why: outcome.stopped, at: outcome.at } };
}

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

async function openThreadIdByKeyOrId(word: string): Promise<string | undefined> {
  const key = await store.threads.key(word);
  const found = (await store.threads.list({ open: true })).find(({ thread }) => thread === key);

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
// A new session beside General learns from the job where its work came from. News of a job's end closes its run in hex.db wherever it lands.
const News = z.object({
  unit: z.string(),
  owner: z.string(),
  said: z.string(),
  at: z.string(),
  from: z.array(z.string()),
  ends: z.object({ machine: z.string(), run: z.string() }).optional(),
});

type Ends = z.infer<typeof News>["ends"];

const startedBy = () =>
  ["HEX_FROM", "HEX_FROM_AT"].flatMap((name) =>
    isSet(process.env[name]) ? [`${name}=${process.env[name]}`] : [],
  );

async function tell(unit: string, owner: string, said: string, at: string, ends?: Ends) {
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
            ...(ends === undefined ? [] : [ends.machine, ends.run]),
          ]);

    if (sent?.exitCode === 0) {
      return;
    }

    mkdirSync(records, { recursive: true });
    writeFileSync(
      join(records, `${unit}@${Bun.hash(at)}.news`),
      JSON.stringify({ unit, owner, said, at, from: startedBy(), ends }),
    );
    console.error(
      `job: ${unit}'s news waits in ${records} for hex to start somewhere: ${sent?.stderr.toString().trim() ?? "hex is still moving"}`,
    );

    return;
  }

  if (ends !== undefined) {
    await store.jobs.ended(unit, ends.machine, ends.run);
  }

  const to = await store.threads.key(owner);

  const from =
    besideWhat(to) === undefined
      ? undefined
      : await origin(store, process.env.HEX_FROM, process.env.HEX_FROM_AT);

  await store.messages.deliver({
    key: `job:${unit}@${at}`,
    to,
    from: "job",
    author: "prompt",
    body: [`[job] ${unit} ${said}`, from].filter(isSet).join("\n"),
    meta: { user: "job", job: unit },
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A job that stopped without ending tells hex.db, wherever hex runs; one that can't reach it, or stops as hex moves, leaves the next resume to ask this machine, so a move never waits on its jobs.
async function toldStopped(unit: string, run: string, why: StopReason, at: string) {
  const there = await whereHexIs(0);

  if (there === "here") {
    await store.jobs.stopped(unit, hostname(), run, why, at);
  } else if (there !== "moving") {
    await onMachine(there, [
      join(import.meta.dir, "job"),
      "--stopped",
      unit,
      hostname(),
      run,
      why,
      at,
    ]);
  }
}

async function nameOf(owner: string) {
  const key = await store.threads.key(owner);

  const ran = await store.messages.ranFor(key);
  const thread = besideWhat(key) ?? (ran === null ? undefined : besideWhat(ran.to)) ?? key;

  return (await store.threads.names())[thread] ?? thread;
}

if (mode === "--owner") {
  console.log(reportsTo() ?? "");
} else if (mode === "--ended") {
  const [unit = "", owner = "", run = "", session = ""] = rest;

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

  const at = new Date().toISOString();

  mkdirSync(outcomes, { recursive: true });
  writeFileSync(join(outcomes, unit), JSON.stringify({ run, stopped, at }));

  if (stopped !== "ended") {
    await toldStopped(unit, run, stopped, at);
    process.exit(0);
  }

  const output = lastOutput(unit);
  const key = await store.threads.key(owner);
  const thread = besideWhat(key) ?? key;

  if (
    !(await store.messages.took(key)) &&
    !(await store.threads.list()).some((each) => each.thread === thread)
  ) {
    console.error(
      `job: ${unit} ended, but no app has the thread ${owner} yet; its end waits there`,
    );
  }

  const service = process.env.SERVICE_RESULT ?? "unknown";
  const status = process.env.EXIT_STATUS ?? "?";
  const result = service === "success" && process.env.EXIT_CODE === "killed" ? "stopped" : service;

  const check = isSet(session)
    ? `Its conversation, if it ran here: \`${join(import.meta.dir, "hex")} log -- ${session}\``
    : "Check what it shows against the real thing before you report it.";

  const invocation = process.env.INVOCATION_ID ?? `${Date.now()}`;

  await tell(unit, owner, `ended: ${result} (exit ${status}).\n${output}\n${check}`, invocation, {
    machine: hostname(),
    run,
  });

  if (service !== "success" && service !== "unknown") {
    await tell(
      unit,
      signalTo("job-failed"),
      `ended: ${result} (exit ${status}).`,
      `${invocation}:failed`,
    );
  }
} else if (mode === "--waiting") {
  const [unit = "", owner = "", readings = ""] = rest;

  await tell(
    unit,
    owner,
    `waits for room: no machine has a free slot with the CPU, memory and disk a job needs right now. It starts by itself once one does.${readings}`,
    `${process.env.INVOCATION_ID ?? Date.now()}:waiting`,
  );
} else if (mode === "--tell") {
  const [unit = "", owner = "", said = "", at, machine, run] = rest;

  await tell(
    unit,
    owner,
    said,
    at ?? `${process.env.INVOCATION_ID ?? Date.now()}:${Bun.hash(said)}`,
    machine === undefined || run === undefined ? undefined : { machine, run },
  );
} else if (mode === "--stopped") {
  const [unit = "", machine = "", run = "", why, at] = rest;

  await store.jobs.stopped(unit, machine, run, StopReasonColumn.parse(why), at);
} else if (mode === "--running") {
  for (const asked of rest) {
    const [unit = "", run] = asked.split("=");
    let state = await stateOf(unit);

    for (
      let waited = 0;
      state === "deactivating" && waited < STOPPING_SETTLES_WITHIN_MS;
      waited += 500
    ) {
      await Bun.sleep(500);
      state = await stateOf(unit);
    }

    const outcome = outcomeOf(unit, run);

    if (RUNS_OR_STILL_ENDS.has(state)) {
      console.log(`active ${unit}`);
    } else if (outcome?.stopped === "ended") {
      console.log(`gone ${unit}`);
    } else if (outcome === undefined) {
      console.log(`unknown ${unit}`);
    } else {
      console.log(`stopped ${unit} ${outcome.stopped} ${outcome.at}`);
    }
  }
} else if (mode === "--resume") {
  if ((await whereHexIs()) !== "here") {
    console.error("job: hex runs on another machine, so its jobs carry on from there");
    process.exit(0);
  }

  if (!resumesAlone()) {
    console.error("job: another resume is carrying jobs on already");
    process.exit(0);
  }

  const gone = new Set(
    existsSync(machinesGone) ? readFileSync(machinesGone, "utf-8").split("\n").filter(isSet) : [],
  );

  for (const file of existsSync(records) ? readdirSync(records) : []) {
    if (/\.(json|ended)$/u.test(file)) {
      rmSync(join(records, file), { force: true });
    }
  }

  const here = hostname();
  const at = new Date().toISOString();

  const stopped = async (unit: string, owner: string, said: string) => {
    await tell(unit, owner, said, `${at}:again`);
    await tell(unit, signalTo("job-stopped"), said, `${at}:stopped`);
  };

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
      const { unit, owner, said, at: sentAt, from, ends } = news;

      const before = { HEX_FROM: process.env.HEX_FROM, HEX_FROM_AT: process.env.HEX_FROM_AT };
      delete process.env.HEX_FROM;
      delete process.env.HEX_FROM_AT;

      for (const pair of from) {
        const [name = "", ...value] = pair.split("=");
        process.env[name] = value.join("=");
      }

      await tell(unit, owner, said, sentAt, ends);

      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
  }

  const jobs = await store.jobs.list();
  const elsewhereNow = await stillOnTheirMachines(jobs.filter(({ machine }) => machine !== here));

  for (const job of jobs) {
    const { unit, machine, run, spec: kept } = job;
    const now = machine === here ? await nowHere(unit, run) : elsewhereNow.get(unit);
    const command = kept.command.join(" ");

    if (now === undefined) {
      console.error(`job: ${machine} said nothing of ${unit}, so it's left to it`);
      continue;
    }

    if (now.state === "active") {
      continue;
    }

    if (now.state === "ended") {
      await store.jobs.ended(unit, machine, run);
      continue;
    }

    const stillThere = job.stopped === undefined && !gone.has(machine);

    if (now.state === "down" && stillThere) {
      console.error(
        `job: ${machine} doesn't answer, so ${unit} is left to it until it's known to be gone`,
      );
      continue;
    }

    if (now.state === "unknown" && stillThere && machine !== here) {
      await store.jobs.ended(unit, machine, run);
      await stopped(
        unit,
        kept.owner,
        `stopped on ${machine} without a word of how, and ${machine} is up, so it isn't started again on ${here}. Start it again if its work still needs doing: ${command}`,
      );
      continue;
    }

    const stop = job.stopped ?? (now.state === "stopped" ? now.stop : undefined);
    const then = stop === undefined ? "" : ` at ${when(stop.at)}`;
    const moved = stop?.why === "moved";

    const why = moved
      ? `hex moved${machine === here ? "" : ` from ${machine}`} to ${here}${then}`
      : stop?.why === "shutdown"
        ? `${machine} shut down${then}`
        : `${machine} went down`;

    const where = moved ? "there" : `as hex started again on ${here} at ${when(at)}`;

    const resumes = valueAfter(kept.command, /^(--resume|-r)$/u);
    const forks = kept.command.includes("--fork-session");
    const continues = kept.command.some((arg) => /^(--continue|-c)$/u.test(arg));
    const session = kept.session ?? (forks ? undefined : resumes);
    const agent = basename(kept.command[0] ?? "") === "claude";
    const conversation = agent && isSet(session) && saved(session);

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
      await store.jobs.ended(unit, machine, run);
      await stopped(
        unit,
        kept.owner,
        `stopped because ${why}, and hasn't run since: ${leftToItsOwner}. Start it again if its work still needs doing: ${command}`,
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

    const over: JobSpec = { ...kept, startedOver: [...startsOver, at] };

    if (agent) {
      over.session = crypto.randomUUID();
    }

    const started = await launch(
      unit,
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

    await stopped(unit, kept.owner, `stopped because ${why}, and ${said}`);
  }

  rmSync(machinesGone, { force: true });
  rmSync(resuming, { force: true });
} else if ((await whereHexIs()) === "here") {
  const given = rest.length > 1 ? await openThreadIdByKeyOrId(rest[0] ?? "") : undefined;
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
    await store.tasks.addAgents(task, [session]);
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

  const kept: JobSpec = {
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One resume at a time on this machine, kept outside hex.db so it never travels with it: a resume that was killed leaves its pid, which no longer runs, and the next one takes over.
function resumesAlone() {
  mkdirSync(join(resuming, ".."), { recursive: true });

  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(resuming, String(process.pid), { flag: "wx" });

      return true;
    } catch {
      const pid = Number(readFileSync(resuming, "utf-8"));

      if (Number.isInteger(pid) && pid > 0 && stillRuns(pid)) {
        return false;
      }

      rmSync(resuming, { force: true });
    }
  }

  return false;
}

function stillRuns(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
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

function startArgs({ command, session }: JobSpec) {
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
// A job left running on the machine hex moved from carries on there, and one that ended there is done: its own machine says which, from its own record of the run, while it answers.
async function stillOnTheirMachines(jobs: Pick<Job, "unit" | "machine" | "run">[]) {
  const said = new Map<string, Now>();

  for (const [machine, theirs] of Map.groupBy(jobs, (job) => job.machine)) {
    const asked = await onMachine(machine, [
      join(import.meta.dir, "job"),
      "--running",
      ...theirs.map(({ unit, run }) => `${unit}=${run}`),
    ]);

    if (asked.exitCode === SSH_CANT_REACH_IT) {
      for (const { unit } of theirs) {
        said.set(unit, { state: "down" });
      }

      continue;
    }

    if (asked.exitCode !== 0) {
      for (const { unit } of theirs) {
        said.set(unit, { state: "active" });
      }

      console.error(
        `job: ${machine} couldn't say what still runs there, so its jobs are left to it`,
      );
      continue;
    }

    for (const line of asked.stdout.toString().split("\n")) {
      const [state, unit = "", why, at = ""] = line.split(" ");
      const stopped = StopReasonColumn.safeParse(why);

      if (state === "active") {
        said.set(unit, { state: "active" });
      } else if (state === "gone") {
        said.set(unit, { state: "ended" });
      } else if (state === "unknown") {
        said.set(unit, { state: "unknown" });
      } else if (state === "stopped" && stopped.success) {
        said.set(unit, { state: "stopped", stop: { why: stopped.data, at } });
      }
    }
  }

  return said;
}

function keptNews(file: string) {
  const text = readFileSync(file, "utf-8");

  return News.safeParse(text.startsWith("{") ? JSON.parse(text) : undefined).data;
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

async function pruneOldLogs() {
  for (const file of readdirSync(records).filter((each) => each.endsWith(".log"))) {
    const log = join(records, file);
    const running = (await store.jobs.get(file.replace(/\.log$/u, ""))) !== undefined;
    const written = statSync(log, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();

    if (!running && Date.now() - written > LOGS_KEPT_FOR_THEIR_THREADS_MS) {
      rmSync(log, { force: true });
    }
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
  kept: JobSpec,
  args: string[],
  input: string[] = [],
  fresh = false,
) {
  if ((await $`systemctl --user is-active --quiet ${unit}`.nothrow()).exitCode === 0) {
    console.error(`job: ${unit} already runs`);

    return 1;
  }

  const before = await store.jobs.get(unit);

  if (
    fresh &&
    before !== undefined &&
    before.machine !== hostname() &&
    ["active", undefined].includes((await stillOnTheirMachines([before])).get(unit)?.state)
  ) {
    console.error(`job: ${unit} already runs on ${before.machine}, or it can't say it doesn't`);

    return 1;
  }

  mkdirSync(records, { recursive: true });

  const agent = basename(kept.command[0] ?? "") === "claude";
  const name = `${await nameOf(kept.owner)}/${unit}`;
  const startedAt = new Date().toISOString();
  await store.jobs.started(unit, hostname(), startedAt, kept);

  const log = join(records, `${unit}.log`);

  if (fresh) {
    writeFileSync(log, "");
    await pruneOldLogs();
  }

  const run = agent ? [`${import.meta.dir}/place`, name, ...args] : kept.command;
  const roomToStopAndTellItsThread = ["-p", "TimeoutStopSec=90s"];
  const givesWayToTheAgentsLikeWhatTheyRun = agent ? [] : ["-p", "Nice=10"];

  const started =
    await $`systemd-run --user --unit=${unit} --slice=hex-jobs.slice --working-directory=${kept.cwd} ${input} ${roomToStopAndTellItsThread} ${givesWayToTheAgentsLikeWhatTheyRun} --collect -p ${`StandardOutput=append:${log}`} -p ${`StandardError=append:${log}`} ${kept.properties} -E CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 -E HEX_OWNER=${kept.owner} -E CLAUDE_CODE_SESSION_NAME=${name} -p ${verbatimPastSystemdsVariableExpansion(`ExecStopPost=${process.execPath} ${join(import.meta.dir, "job")} ${["--ended", unit, kept.owner, startedAt, kept.session].filter(isSet).join(" ")}`)} -- ${run.map(verbatimPastSystemdsVariableExpansion)}`
      .cwd(existsSync(kept.cwd) ? kept.cwd : process.cwd())
      .nothrow();

  if (started.exitCode !== 0) {
    await store.jobs.ended(unit, hostname(), startedAt);
  }

  return started.exitCode;
}

function verbatimPastSystemdsVariableExpansion(arg: string) {
  return arg.replaceAll("$", () => "$$");
}
