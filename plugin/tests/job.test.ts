import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { open } from "../../hub/store.ts";

const Args = z.array(z.string());

// oxlint-disable anti-slop/no-unknown-returns -- bun types its asymmetric matchers as any, and unknown keeps that any out of the expectations
const containing = (text: string): unknown => expect.stringContaining(text);
const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
// oxlint-enable anti-slop/no-unknown-returns -- the matchers end here

const HEX = join(import.meta.dir, "../..");
const home = mkdtempSync(join(tmpdir(), "job-"));
const job = join(home, ".hex/bin/job");
const ran = join(home, "ran.json");
const launches = join(home, "launches.jsonl");
const folders = join(home, "folders.txt");
const here = hostname();
const clockTime = String.raw`[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M [A-Z][A-Za-z0-9+:-]+`;

setDefaultTimeout(30_000);

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("HEX_") && !["CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR"].includes(name),
  ),
);

env.XDG_STATE_HOME = join(home, "xdg");

const session = { HEX_CHANNEL: "plugin:t3@hex", HEX_THREAD: "stray-key" };

beforeAll(() => {
  for (const file of [
    "bin/job",
    "bin/hex",
    "bin/session",
    "hub/cli.ts",
    "hub/fit.ts",
    "hub/notes.ts",
    "hub/tasks.ts",
    "hub/schedule.ts",
    "hub/clock.ts",
    "hub/zone.ts",
    "hub/store.ts",
    "hub/store",
    "hub/running.ts",
    "hub/claude.ts",
    "hub/until.ts",
    "hub/beside.ts",
    "hub/origin.ts",
    "hub/mcp.ts",
  ]) {
    cpSync(join(HEX, file), join(home, ".hex", file), { dereference: true, recursive: true });
  }

  for (const [app, threads] of Object.entries({
    t3: { "stray-key": { name: "hex" } },
    telegram: { "-100123:101": { name: "orchard" } },
    discord: { "555": { name: "urgent fix" } },
  })) {
    open(join(home, "state")).threads.keep(app, threads);
  }

  mkdirSync(join(home, "fake"));
  writeFileSync(
    join(home, "fake/systemd-run"),
    `#!/bin/sh
case "$*" in *--unit=refused*) exit 1 ;; esac
jq -cn '$ARGS.positional' --args -- "$@" | tee "${ran}" >> "${launches}"
pwd >> "${folders}"
`,
  );
  chmodSync(join(home, "fake/systemd-run"), 0o755);
  writeFileSync(
    join(home, "fake/systemctl"),
    `#!/bin/sh
case "$1" in
  is-system-running) cat "${home}/system.txt" 2>/dev/null || echo running ;;
  --user) for unit; do :; done
    if [ "$2" = show ]; then grep -qx "$unit" "${home}/stopping.txt" 2>/dev/null && echo 7; exit 0; fi
    if grep -qx "$unit" "\${ACTIVE:-${home}/active.txt}" 2>/dev/null; then echo active; else echo inactive; exit 3; fi ;;
esac
`,
  );
  chmodSync(join(home, "fake/systemctl"), 0o755);
  writeFileSync(
    join(home, "fake/ssh"),
    `#!/bin/sh
prev=
for arg; do host=$prev; prev=$arg; done
echo "$host $prev" >> "${home}/ssh.log"
case "$host" in
  log-x) exit 0 ;;
  twin-x) XDG_STATE_HOME="${home}/xdg-twin" HEX_STORE="${home}/twin" ACTIVE="${home}/twin-active.txt" exec sh -c "$prev" ;;
  *) exit 255 ;;
esac
`,
  );
  chmodSync(join(home, "fake/ssh"), 0o755);
  mkdirSync(join(home, "twin/jobs"), { recursive: true });
});

afterAll(() => {
  rmSync(home, { recursive: true });
});

function run(args: string[], more: Record<string, string> = {}, cwd = home, stdin = "") {
  rmSync(ran, { force: true });

  const done = Bun.spawnSync(["bun", job, ...args], {
    cwd,
    stdin: Buffer.from(stdin),
    env: { ...env, PATH: `${join(home, "fake")}:${env.PATH}`, ...more },
    stderr: "pipe",
  });

  return {
    code: done.exitCode,
    error: done.stderr.toString(),
    args: done.exitCode ? [] : Args.parse(JSON.parse(readFileSync(ran, "utf-8"))),
  };
}

const value = (args: string[], name: string) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

test("a job a hex session starts is its thread's, in that session's own app, and its sessions are named for it, and one with no agent gives way to the agents", () => {
  const { args, error } = run(["round3", "make", "all"], session);
  expect(args.slice(args.indexOf("--"))).toEqual(["--", "make", "all"]);
  expect(args).toContain(`--working-directory=${home}`);
  expect(args).toContain("--slice=hex-jobs.slice");
  expect(args).toContain("Nice=10");
  expect(error).toBe("");
  expect(value(args, "HEX_OWNER")).toBe("t3:stray-key");
  expect(value(args, "CLAUDE_CODE_SESSION_NAME")).toBe("hex/round3");
  expect(value(args, "ExecStopPost")).toEndWith("job --ended round3 t3:stray-key");
  expect(run(["round3", "stray-key", "claude"], session).args).toContain("HEX_OWNER=t3:stray-key");
});

test("a job General or a session beside a thread starts reports beside it, so General's conversation stays the owner's", async () => {
  const general = { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100123:101" };
  expect(value(run(["mail", "make"], { ...general, HEX_MAIN: "1" }).args, "HEX_OWNER")).toBe(
    "telegram:beside:-100123:101",
  );
  const besideIt = run(["mail", "claude", "-p", "go"], { ...general, HEX_BESIDE: "b-1" }).args;
  expect(value(besideIt, "HEX_OWNER")).toBe("telegram:b-1");

  const owner = Bun.spawnSync(["bun", job, "--owner"], {
    env: { ...env, ...general, HEX_BESIDE: "b-1" },
  });

  expect(owner.stdout.toString()).toBe("telegram:b-1\n");

  await Bun.spawn(["bun", job, "--ended", "mail", "telegram:beside:-100123:101"], {
    env: {
      ...env,
      SERVICE_RESULT: "success",
      EXIT_STATUS: "0",
      HEX_FROM: "telegram:-100123:101",
      HEX_FROM_AT: new Date().toISOString(),
    },
    stderr: "pipe",
  }).exited;

  const told = open(join(home, "state"))
    .messages.untaken()
    .find((row) => row.key.startsWith("job:mail@"));

  expect(told?.to).toBe("beside:-100123:101");
  expect(told?.body).toContain("This work comes from my conversation in orchard");
  open(join(home, "state")).db.run("delete from messages where key = ?", [told?.key ?? ""]);
});

test("an agent job goes to a machine with room, from the folder it was started from", () => {
  const priced = run(["atrium", "claude", "-p", "cost $5 in $HOME"], session).args;
  expect(priced.at(-1)).toBe("cost $$5 in $$HOME");
  const project = mkdtempSync(join(home, "atrium-"));
  const away = run(["atrium", "claude", "-p", "build it", "--model", "opus"], session, project);
  expect(away.args).toContain(`--working-directory=${project}`);
  expect(away.args).not.toContain("Nice=10");
  const placed: unknown[] = away.args.slice(away.args.indexOf("--"));
  expect(placed).toEqual([
    "--",
    join(home, ".hex/bin/place"),
    "hex/atrium",
    "--session-id",
    matching(/^[0-9a-f-]{36}$/u),
    "-p",
    "build it",
    "--model",
    "opus",
  ]);
  const chosen = run(["atrium", "claude", "--session-id", "abc", "-p", "go"], session).args;
  expect(chosen.slice(chosen.indexOf("--"))).toEqual([
    "--",
    join(home, ".hex/bin/place"),
    "hex/atrium",
    "--session-id",
    "abc",
    "-p",
    "go",
  ]);
  const resumed = run(["atrium", "claude", "--resume", "abc", "-p", "go on"], session).args;
  expect(resumed.slice(resumed.indexOf("--"))).toEqual([
    "--",
    join(home, ".hex/bin/place"),
    "hex/atrium",
    "--resume",
    "abc",
    "-p",
    "go on",
  ]);
  expect(value(away.args, "StandardInputData")).toBeUndefined();
  const piped = run(["atrium", "claude", "-p"], session, home, "Build the Usage tab.\n");
  expect(Buffer.from(value(piped.args, "StandardInputData") ?? "", "base64").toString()).toBe(
    "Build the Usage tab.\n",
  );
});

async function launchedOverASocket(write?: string) {
  rmSync(ran, { force: true });

  const child = Bun.spawn(["bun", job, "atrium", "claude", "-p"], {
    cwd: home,
    stdin: "pipe",
    env: { ...env, PATH: `${join(home, "fake")}:${env.PATH}`, ...session },
  });

  if (write !== undefined) {
    void child.stdin.write(write);
    void child.stdin.end();
  }

  await child.exited;
  void child.stdin.end();

  return Args.parse(JSON.parse(readFileSync(ran, "utf-8")));
}

test("an agent job starts whether its parent's stdin socket stays silent, or carries the prompt", async () => {
  expect(value(await launchedOverASocket(), "StandardInputData")).toBeUndefined();
  const piped = await launchedOverASocket("Build it.\n");
  expect(Buffer.from(value(piped, "StandardInputData") ?? "", "base64").toString()).toBe(
    "Build it.\n",
  );
});

test("a shell that would run Claude is told how to start it as a hex session", () => {
  expect(run(["atrium", "sh", "-c", "cd atrium && claude -p go"], session).error).toContain(
    'job atrium claude -p "<prompt>"',
  );
  expect(run(["build", "rm", "-rf", ".claude/worktrees/old"], session).error).toBe("");
});

test("a job a job session starts is its owner's too", () => {
  expect(value(run(["inner", "make"], { HEX_OWNER: "discord:555" }).args, "HEX_OWNER")).toBe(
    "discord:555",
  );
});

test("a job session's prompts are hex's words in hex.db, the first and every later one, its answer too, what the owner types in a terminal is theirs, and an app session's terminal words are kept as unsent", () => {
  const state = join(home, "state");

  const hook = (step: string, input: Record<string, string>, extra: Record<string, string> = {}) =>
    Bun.spawnSync(["bun", join(HEX, "hub/state.ts"), step], {
      stdin: Buffer.from(JSON.stringify(input)),
      env: { ...env, HEX_STORE: state, MEMORY_DIR: "", ...extra },
    });

  hook(
    "busy",
    { session_id: "job-1", prompt: "Build the atrium tab." },
    { HEX_OWNER: "t3:stray-key" },
  );
  hook(
    "idle",
    { hook_event_name: "Stop", session_id: "job-1", last_assistant_message: "Built." },
    { HEX_OWNER: "t3:stray-key" },
  );
  hook("busy", { session_id: "job-1", prompt: "make the tab blue" }, { HEX_OWNER: "t3:stray-key" });
  hook("busy", { session_id: "mine-1", prompt: "what is up" });
  hook("busy", { session_id: "mine-1", prompt: "<task-notification>done</task-notification>" });
  hook("busy", { session_id: "mine-1", prompt: '<agent-message from="a1">merged</agent-message>' });
  hook("busy", {
    session_id: "mine-1",
    prompt: '<cross-session-message from="s2">done</cross-session-message>',
  });
  hook("busy", {
    session_id: "mine-1",
    prompt: '<teammate-message teammate_id="t1">hi</teammate-message>',
  });
  hook("busy", { session_id: "mine-1", prompt: "/compact" });
  hook(
    "idle",
    { hook_event_name: "Stop", session_id: "chat-1", last_assistant_message: "narration" },
    { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:1" },
  );

  const rows = open(state)
    .messages.since()
    .map(({ to, from, author, body, taken }) => ({ to, from, author, body, by: taken?.by }));

  expect(rows).toEqual([
    { to: "job-1", from: "terminal", author: "prompt", body: "Build the atrium tab.", by: "job-1" },
    { to: "job-1", from: "terminal", author: "hex", body: "Built.", by: "job-1" },
    { to: "job-1", from: "terminal", author: "prompt", body: "make the tab blue", by: "job-1" },
    { to: "mine-1", from: "terminal", author: "owner", body: "what is up", by: "mine-1" },
    { to: "-100:1", from: "terminal", author: "hex", body: "narration", by: "chat-1" },
  ]);
  expect(open(state).messages.said("-100:1")[0]?.meta).toEqual({
    session: "chat-1",
    unsent: "true",
  });
});

test("a named owner is an open thread's key or its <app>:<key> id", () => {
  expect(value(run(["build", "-100123:101", "make"], session).args, "HEX_OWNER")).toBe(
    "telegram:-100123:101",
  );
  expect(value(run(["build", "-100123:101", "make"], session).args, "HEX_FROM")).toBe(
    "t3:stray-key",
  );
  expect(value(run(["build", "make"], session).args, "HEX_FROM")).toBe("t3:stray-key");
  expect(value(run(["build", "make"], session).args, "HEX_FROM_AT")).toMatch(/^\d{4}-\d\d-\d\dT/u);
  expect(value(run(["build", "discord:555", "make"]).args, "HEX_FROM")).toBeUndefined();
  expect(
    value(
      run(["inner", "make"], { HEX_OWNER: "discord:555", HEX_FROM: "t3:stray-key" }).args,
      "HEX_FROM",
    ),
  ).toBe("t3:stray-key");
  expect(
    value(
      run(["build", "-100123:101", "make"], { ...session, HEX_FROM: "discord:555" }).args,
      "HEX_FROM",
    ),
  ).toBe("t3:stray-key");
  expect(value(run(["build", "discord:555", "make"]).args, "HEX_OWNER")).toBe("discord:555");
  expect(value(run(["build", "555", "make"]).args, "CLAUDE_CODE_SESSION_NAME")).toBe(
    "urgent fix/build",
  );
  expect(
    value(run(["build", "telegram:-100123:101", "make"]).args, "CLAUDE_CODE_SESSION_NAME"),
  ).toBe("orchard/build");
});

test("a job with no owner, or no command, is refused", () => {
  expect(run(["build", "make"]).code).toBe(2);
  expect(run(["build"], session).code).toBe(2);
});

const ended = (...args: string[]) =>
  Bun.spawn(["bun", job, "--ended", ...args], {
    env: { ...env, SERVICE_RESULT: "success", EXIT_STATUS: "0" },
    stderr: "pipe",
  }).exited;

test("a job's end is kept for its owner's thread while no hub runs, by its id or an older unit's bare key", async () => {
  expect(await ended("round3", "t3:stray-key")).toBe(0);
  expect(await ended("older", "555")).toBe(0);
  expect(await ended("topic", "telegram:-100123:101")).toBe(0);
  expect(await ended("early", "telegram:-100123:909")).toBe(0);

  const rows = new Database(join(home, "state/hex.db"))
    .query('select "to", "from", body, meta from messages where taken_at is null order by rowid')
    .all();

  expect(rows).toEqual([
    {
      to: "stray-key",
      from: "job",
      body: containing("[job] round3 ended: success (exit 0)."),
      meta: JSON.stringify({ user: "job", job: "round3" }),
    },
    {
      to: "555",
      from: "job",
      body: containing("[job] older ended"),
      meta: JSON.stringify({ user: "job", job: "older" }),
    },
    {
      to: "-100123:101",
      from: "job",
      body: containing("[job] topic ended"),
      meta: JSON.stringify({ user: "job", job: "topic" }),
    },
    {
      to: "-100123:909",
      from: "job",
      body: containing("[job] early ended"),
      meta: JSON.stringify({ user: "job", job: "early" }),
    },
  ]);
});

test("a job's output is kept in a file of its own, and its end brings the last of it, says where all of it is, and calls a claude job's words its own account to check", async () => {
  const jobs = join(home, "state/jobs");
  const weekOld = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  writeFileSync(join(jobs, "stale.log"), "long done\n");
  utimesSync(join(jobs, "stale.log"), weekOld, weekOld);

  const { args } = run(
    ["pages", "claude", "--session-id", "s-9", "-p", "build the pages"],
    session,
  );

  expect(args).toContain(`StandardOutput=append:${join(jobs, "pages.log")}`);
  expect(args).toContain(`StandardError=append:${join(jobs, "pages.log")}`);
  expect(readFileSync(join(jobs, "pages.log"), "utf-8")).toBe("");
  expect(existsSync(join(jobs, "stale.log"))).toBe(false);
  run(["chatty", "make", "all"], session);
  run(["wide", "make", "all"], session);
  run(["quiet", "make", "all"], session);
  writeFileSync(join(jobs, "pages.log"), "pages runs on server\nbuilt 3 pages\nall pushed\n");
  writeFileSync(
    join(jobs, "chatty.log"),
    Array.from({ length: 41 }, (_, n) => `${n + 1}\n`).join(""),
  );
  writeFileSync(
    join(jobs, "wide.log"),
    ["1", "2", "3"].map((n) => `${n.padStart(2000, "0")}\n`).join(""),
  );

  for (const unit of ["pages", "chatty", "wide", "quiet", "unkept"]) {
    await Bun.spawn(["bun", job, "--ended", unit, "t3:stray-key"], {
      env: { ...env, SERVICE_RESULT: "success", EXIT_STATUS: "0" },
    }).exited;
  }

  const said = (unit: string) =>
    z
      .object({ body: z.string() })
      .parse(
        new Database(join(home, "state/hex.db"))
          .query("select body from messages where body like ? order by rowid desc limit 1")
          .get(`[job] ${unit} ended%`),
      ).body;

  expect(said("pages")).toContain(
    "What it printed last:\n<output>\npages runs on server\nbuilt 3 pages\nall pushed\n</output>",
  );
  expect(said("pages")).toContain("the agent's own account, not proof");
  expect(said("pages")).toContain("log -- s-9");
  expect(said("chatty")).toContain(`, all of it in ${join(jobs, "chatty.log")}:\n<output>\n2\n3\n`);
  expect(said("chatty")).toContain("\n41\n</output>");
  expect(said("chatty")).not.toContain("own account");
  expect(said("wide")).toContain(`<output>\n${"0".repeat(1999)}3\n</output>`);
  expect(said("quiet")).toContain("It printed nothing.");
  expect(said("unkept")).toContain("Its output wasn't kept.");
});

test("a job that runs already is refused, and what it printed so far is kept", () => {
  mkdirSync(join(home, "state/jobs"), { recursive: true });
  writeFileSync(join(home, "state/jobs/busy.log"), "halfway\n");
  writeFileSync(join(home, "active.txt"), "busy\n");
  expect(run(["busy", "make"], session).code).toBe(1);
  expect(readFileSync(join(home, "state/jobs/busy.log"), "utf-8")).toBe("halfway\n");
  rmSync(join(home, "active.txt"));
});

const told = (like: string) =>
  z
    .array(z.string())
    .parse(
      new Database(join(home, "state/hex.db"))
        .query(`select body from messages where "from" = 'job' and body like ? order by rowid`)
        .values(like)
        .flat(),
    );

function resume(config: string, ...gone: string[]) {
  rmSync(launches, { force: true });
  rmSync(folders, { force: true });
  writeFileSync(launches, "");

  const resumed = Bun.spawnSync(
    ["bun", job, "--resume", ...(gone.length > 0 ? ["--gone", ...gone] : [])],
    {
      cwd: home,
      env: { ...env, PATH: `${join(home, "fake")}:${env.PATH}`, CLAUDE_CONFIG_DIR: config },
      stderr: "pipe",
    },
  );

  expect(resumed.exitCode).toBe(0);

  const started = (existsSync(launches) ? readFileSync(launches, "utf-8") : "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Args.parse(JSON.parse(line)));

  return new Map(
    started.map((args) => [
      args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length),
      args,
    ]),
  );
}

const stoppedByASignal = { EXIT_CODE: "killed", EXIT_STATUS: "TERM" };
const finishedByItself = { EXIT_CODE: "exited", EXIT_STATUS: "0" };

const end = (unit: string, how = stoppedByASignal) =>
  Bun.spawnSync(["bun", job, "--ended", unit, "t3:stray-key"], {
    env: { ...env, PATH: `${join(home, "fake")}:${env.PATH}`, ...how },
  });

test("a job the machine going down stopped carries on as hex starts: a claude job in its own conversation, any other job from the beginning", () => {
  const jobs = join(home, "state/jobs");
  rmSync(jobs, { recursive: true, force: true });
  const config = join(home, "claude");
  mkdirSync(join(config, "projects/-atrium"), { recursive: true });
  writeFileSync(join(config, "projects/-atrium/s-1.jsonl"), "{}\n");
  run(
    ["atrium", "claude", "--session-id", "s-1", "-p", "build the atrium", "--model", "opus"],
    session,
  );
  run(["early", "claude", "--session-id", "s-2", "-p", "never saved"], session);
  run(["make", "make", "all"], session);
  run(["live", "make", "all"], session);
  writeFileSync(join(home, "active.txt"), "live\n");
  writeFileSync(join(home, "system.txt"), "stopping\n");
  end("make");
  expect(readFileSync(join(jobs, "make.json"), "utf-8")).toContain('"make","all"');
  rmSync(join(home, "system.txt"));
  writeFileSync(join(jobs, "atrium.log"), "before the machine went down\n");
  writeFileSync(join(jobs, "make.log"), "halfway\n");

  const started = resume(config);

  expect([...started.keys()].toSorted((a = "", b = "") => a.localeCompare(b))).toEqual([
    "atrium",
    "early",
    "make",
  ]);
  const atrium = started.get("atrium") ?? [];
  expect(atrium.slice(atrium.indexOf("--"), -1)).toEqual([
    "--",
    join(home, ".hex/bin/place"),
    "hex/atrium",
    "-p",
    "--model",
    "opus",
    "--resume",
    "s-1",
  ]);
  expect(atrium.at(-1)).toContain(`because ${here} went down; hex runs on ${here} now`);
  expect(atrium.at(-1)).toContain("carry on");
  const early = started.get("early") ?? [];
  const earlyArgs: unknown[] = early.slice(early.indexOf("--") + 2);
  expect(earlyArgs).toEqual([
    "hex/early",
    "--session-id",
    matching(/^[0-9a-f-]{36}$/u),
    "-p",
    "never saved",
  ]);
  expect(early).not.toContain("s-2");
  const make = started.get("make") ?? [];
  expect(make.slice(make.indexOf("--"))).toEqual(["--", "make", "all"]);
  expect(readFileSync(join(jobs, "atrium.log"), "utf-8")).toBe("before the machine went down\n");
  expect(readFileSync(join(jobs, "make.log"), "utf-8")).toBe("halfway\n");
  expect(readFileSync(join(jobs, "make.json"), "utf-8")).not.toContain("stopped");

  const ends: unknown[] = told("%stopped because%").toSorted();
  expect(ends).toEqual([
    matching(
      new RegExp(
        `^\\[job\\] atrium stopped because ${here} went down, and carried on in its own conversation as hex started again on ${here} at ${clockTime}\\.$`,
        "u",
      ),
    ),
    containing(
      `[job] early stopped because ${here} went down, and started over from the beginning as hex started again on ${here} at`,
    ),
    matching(
      new RegExp(
        `^\\[job\\] make stopped because ${here} shut down at ${clockTime}, and started over from the beginning as hex started again on ${here} at ${clockTime}: make all$`,
        "u",
      ),
    ),
  ]);
  rmSync(join(home, "active.txt"));
});

test("jobs hex stopped to move to another machine carry on where it lands, a claude job resuming a conversation and a prompt piped in included, told as a move", () => {
  const jobs = join(home, "state/jobs");
  rmSync(jobs, { recursive: true, force: true });
  const config = join(home, "claude");
  mkdirSync(join(config, "projects/-pick"), { recursive: true });
  writeFileSync(join(config, "projects/-pick/r-1.jsonl"), "{}\n");
  run(["pick", "claude", "-p", "--resume", "r-1", "--model", "opus", "pick up"], session);
  const project = mkdtempSync(join(home, "checks-"));
  run(["checks", "./checks.sh", "--all"], session, project);
  run(["done", "make", "all"], session);
  run(["graceful", "./serve.sh"], session);
  run(["over", "make", "all"], session);
  const overRecord = readFileSync(join(jobs, "over.json"), "utf-8");
  end("over", finishedByItself);
  writeFileSync(join(jobs, "over.json"), overRecord);
  run(["piped", "claude", "-p", "--model", "opus"], session, home, "Build the Usage tab.\n");
  writeFileSync(join(home, "state/moving"), "");

  const records = ["pick", "checks", "piped"].map((unit) => {
    const before = readFileSync(join(jobs, `${unit}.json`), "utf-8");
    end(unit);

    return readFileSync(join(jobs, `${unit}.json`), "utf-8") === before;
  });

  expect(records).toEqual([true, true, true]);
  end("done", finishedByItself);
  expect(existsSync(join(jobs, "done.json"))).toBe(false);
  writeFileSync(join(home, "stopping.txt"), "graceful\n");
  end("graceful", finishedByItself);
  rmSync(join(home, "stopping.txt"));
  expect(existsSync(join(jobs, "graceful.json"))).toBe(true);

  rmSync(join(home, "state/moving"));

  const started = resume(config);

  expect([...started.keys()].toSorted((a = "", b = "") => a.localeCompare(b))).toEqual([
    "checks",
    "graceful",
    "pick",
    "piped",
  ]);
  const pick = started.get("pick") ?? [];
  expect(pick.slice(pick.indexOf("--") + 2, -1)).toEqual([
    "hex/pick",
    "-p",
    "--model",
    "opus",
    "--resume",
    "r-1",
  ]);
  expect(pick.at(-1)).toMatch(
    new RegExp(
      `hex moved to ${here} at ${clockTime}; hex runs on ${here} now \\(${clockTime}\\)`,
      "u",
    ),
  );
  expect(pick.at(-1)).toContain("pick up");
  const checks = started.get("checks") ?? [];
  expect(checks.slice(checks.indexOf("--"))).toEqual(["--", "./checks.sh", "--all"]);
  expect(readFileSync(folders, "utf-8").split("\n")).toContain(project);
  const piped = started.get("piped") ?? [];
  expect(Buffer.from(value(piped, "StandardInputData") ?? "", "base64").toString()).toBe(
    "Build the Usage tab.\n",
  );
  expect(told("%hex moved to%")).toHaveLength(4);
  const pickTold: unknown[] = told("%[job] pick stopped%");
  expect(pickTold).toEqual([
    matching(
      new RegExp(
        `^\\[job\\] pick stopped because hex moved to ${here} at ${clockTime}, and carried on in its own conversation there\\.$`,
        "u",
      ),
    ),
  ]);
  const checksTold: unknown[] = told("%[job] checks stopped%");
  expect(checksTold[0]).toEqual(
    matching(
      new RegExp(
        `at ${clockTime}, and started over from the beginning there: \\./checks\\.sh --all$`,
        "u",
      ),
    ),
  );
  expect(told("%went down%").filter((body) => /\b(pick|checks|piped)\b/u.test(body))).toEqual([]);
  expect(told("%[job] done ended%")).toHaveLength(1);
  expect(told("%[job] graceful ended%")).toEqual([]);
  expect(told("%[job] over stopped%")).toEqual([]);

  for (const time of [1, 2, 3]) {
    writeFileSync(join(home, "state/moving"), "");
    end("checks");
    rmSync(join(home, "state/moving"));
    expect([time, resume(config).has("checks")]).toEqual([time, time < 3]);
  }

  expect(told("%[job] checks stopped%").at(-1)).toContain("started over 3 times in the last hour");
});

test("a job that can't come back as it was is told to its owner, and a bad or conflicting record holds up no other job", () => {
  const jobs = join(home, "state/jobs");
  rmSync(jobs, { recursive: true, force: true });
  const config = join(home, "claude");
  mkdirSync(join(config, "projects/-older"), { recursive: true });
  writeFileSync(join(config, "projects/-older/o-1.jsonl"), "{}\n");
  run(["latest", "claude", "-p", "--continue", "go on"], session);
  mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, "broken.json"), "{");
  writeFileSync(
    join(jobs, "olden.json"),
    JSON.stringify({
      owner: "t3:stray-key",
      cwd: home,
      properties: [],
      command: ["claude", "-p", "--resume", "o-1", "first words"],
    }),
  );
  writeFileSync(join(jobs, "olden.sync-conflict-20261113-010055-ABC.json"), "{}");
  const owned = { owner: "t3:stray-key", cwd: home, properties: [] };
  writeFileSync(
    join(jobs, "forked.json"),
    JSON.stringify({
      ...owned,
      command: ["claude", "-p", "--resume", "o-1", "--fork-session", "x"],
    }),
  );
  writeFileSync(
    join(jobs, "twice.json"),
    JSON.stringify({
      ...owned,
      command: ["make", "all"],
      startedOver: [1, 2, 3].map((minutes) =>
        new Date(Date.now() - minutes * 60_000).toISOString(),
      ),
    }),
  );
  writeFileSync(
    join(jobs, "gone.json"),
    JSON.stringify({ ...owned, command: ["claude", "-p", "--resume", "g-1", "x"] }),
  );
  writeFileSync(join(jobs, "refused.json"), JSON.stringify({ ...owned, command: ["make", "all"] }));
  writeFileSync(
    join(jobs, "away.json"),
    JSON.stringify({ ...owned, command: ["make", "all"], machine: "elsewhere" }),
  );

  const started = resume(config, "elsewhere");

  expect([...started.keys()].toSorted((a = "", b = "") => a.localeCompare(b))).toEqual([
    "away",
    "olden",
  ]);

  const olden = started.get("olden") ?? [];
  expect(olden.slice(olden.indexOf("--") + 2, -1)).toEqual(["hex/olden", "-p", "--resume", "o-1"]);

  const left: unknown[] = told("%hasn't run since%")
    .filter((body) => /\[job\] (latest|forked|twice|gone) /u.test(body))
    .toSorted();

  expect(left).toEqual([
    containing(
      "[job] forked stopped because the machine went down, and hasn't run since: it would",
    ),
    containing(
      `[job] gone stopped because the machine went down, and hasn't run since: the conversation it resumes isn't on ${here}`,
    ),
    containing("[job] latest stopped"),
    containing(
      "[job] twice stopped because the machine went down, and hasn't run since: it started over 3 times",
    ),
  ]);
  const refused: unknown[] = told("%[job] refused stopped%");
  expect(refused).toEqual([containing("couldn't start again")]);
  const away: unknown[] = told("%[job] away stopped%");
  expect(away).toEqual([containing(`because elsewhere went down, and started over`)]);
  expect(existsSync(join(jobs, "broken.json"))).toBe(true);
});

const forwarded = (logged: string) =>
  Buffer.from(/printf %s (\S+)/u.exec(logged)?.[1] ?? "", "base64")
    .toString()
    .split("\0");

const fakes = () => ({ ...env, PATH: `${join(home, "fake")}:${env.PATH}` });
const marker = join(home, "xdg/hex/elsewhere");

const toldOn = (store: string, like: string) =>
  z
    .array(z.string())
    .parse(
      new Database(join(home, store, "hex.db"))
        .query(`select body from messages where body like ? order by rowid`)
        .values(like)
        .flat(),
    );

test("on a machine hex moved away from, a job's end and hex's commands go to the machine hex runs on", () => {
  mkdirSync(join(home, "xdg/hex"), { recursive: true });
  run(["leftover", "make", "all"], session);
  writeFileSync(marker, "twin-x\n");
  rmSync(join(home, "ssh.log"), { force: true });
  open(join(home, "twin")).threads.keep("t3", { "stray-key": { name: "hex" } });
  end("leftover", finishedByItself);

  const there: unknown[] = toldOn("twin", "%[job] leftover ended%");
  expect(there).toEqual([containing("[job] leftover ended: unknown (exit 0)")]);
  expect(told("%[job] leftover ended%")).toEqual([]);

  writeFileSync(marker, "log-x\n");

  const delivered = Bun.spawnSync(
    [join(home, ".hex/bin/hex"), "deliver", "hex", "--to=stray-key", "from the server"],
    { env: fakes() },
  );

  expect(delivered.exitCode).toBe(0);

  const asked = readFileSync(join(home, "ssh.log"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => line.split(" "));

  expect(asked.map(([host]) => host)).toEqual(["twin-x", "log-x"]);

  const started = Bun.spawnSync(["bun", job, "later", "make", "all"], {
    env: { ...fakes(), ...session },
    cwd: home,
  });

  expect(started.exitCode).toBe(0);
  expect(
    forwarded(readFileSync(join(home, "ssh.log"), "utf-8").trim().split("\n").at(-1) ?? "").slice(
      -5,
    ),
  ).toEqual([home, job, "later", "make", "all"]);
  expect(existsSync(join(home, "state/jobs/later.json"))).toBe(false);
  expect(forwarded(asked.at(-1)?.join(" ") ?? "")).toEqual([
    join(home, ".hex/bin/hex"),
    "deliver",
    "hex",
    "--to=stray-key",
    "from the server",
    "",
  ]);
  rmSync(marker);
});

test("a job's end waits out a move, and one that can't reach hex is kept until hex starts somewhere", async () => {
  mkdirSync(join(home, "xdg/hex"), { recursive: true });
  run(["mid", "make", "all"], session);
  writeFileSync(marker, "");

  const ending = Bun.spawn(["bun", job, "--ended", "mid", "t3:stray-key"], {
    env: { ...fakes(), ...finishedByItself },
  });

  await Bun.sleep(1500);
  writeFileSync(marker, "twin-x\n");
  await ending.exited;

  expect(toldOn("twin", "%[job] mid ended%")).toHaveLength(1);

  run(["far", "make", "all"], session);
  writeFileSync(marker, "dead-x\n");
  end("far", finishedByItself);
  rmSync(marker);

  expect(told("%[job] far ended%")).toEqual([]);
  expect(
    readdirSync(join(home, "state/jobs")).filter((file) => file.startsWith("far@")),
  ).toHaveLength(1);

  resume(join(home, "claude"));

  expect(told("%[job] far ended%")).toHaveLength(1);
  expect(readdirSync(join(home, "state/jobs")).filter((file) => file.startsWith("far@"))).toEqual(
    [],
  );
});

test("hex runs, and updates, on the machine it was moved to, not on the one it left", () => {
  mkdirSync(join(home, "xdg/hex"), { recursive: true });
  writeFileSync(marker, "log-x\n");
  rmSync(join(home, "ssh.log"), { force: true });

  const started = Bun.spawnSync([join(home, ".hex/bin/hex"), "run"], {
    env: fakes(),
    stderr: "pipe",
  });

  expect(started.exitCode).toBe(1);
  expect(started.stderr.toString()).toContain("hex runs on another machine now");

  const asked = Bun.spawnSync([join(home, ".hex/bin/hex"), "tasks"], {
    env: { ...fakes(), HEX_THREAD: "stray-key", HEX_OWNER: "t3:stray-key" },
  });

  expect(asked.exitCode).toBe(0);

  const line = readFileSync(join(home, "ssh.log"), "utf-8").trim().split(" ");

  expect(line[0]).toBe("log-x");
  expect(forwarded(line.join(" "))).toEqual([
    "HEX_THREAD=stray-key",
    "HEX_OWNER=t3:stray-key",
    join(home, ".hex/bin/hex"),
    "tasks",
    "",
  ]);
  rmSync(marker);
});

test("hex starting here leaves a job still running on the machine it left there, drops one that ended there, and starts one whose machine doesn't answer", () => {
  const jobs = join(home, "state/jobs");
  rmSync(jobs, { recursive: true, force: true });
  mkdirSync(jobs, { recursive: true });
  const config = join(home, "claude");

  const record = (unit: string, machine: string) => {
    writeFileSync(
      join(jobs, `${unit}.json`),
      JSON.stringify({
        owner: "t3:stray-key",
        cwd: home,
        properties: [],
        command: ["make", unit],
        machine,
      }),
    );
  };

  record("kept", "twin-x");
  record("finished", "twin-x");
  record("lost", "dead-x");
  record("cut", "twin-x");
  writeFileSync(join(home, "twin/jobs/cut.json"), "{}");
  writeFileSync(join(home, "twin-active.txt"), "kept\n");
  const first = resume(config);

  expect([...first.keys()]).toEqual(["cut"]);
  expect(existsSync(join(jobs, "lost.json"))).toBe(true);
  expect(told("%[job] lost stopped%")).toEqual([]);

  rmSync(join(jobs, "cut.json"));

  const started = resume(config, "dead-x");

  expect([...started.keys()]).toEqual(["lost"]);
  expect(existsSync(join(jobs, "kept.json"))).toBe(true);
  expect(existsSync(join(jobs, "finished.json"))).toBe(false);
  expect(told("%[job] kept %")).toEqual([]);
  expect(told("%[job] finished %")).toEqual([]);
  const cut: unknown[] = told("%[job] cut stopped%");
  expect(cut).toEqual([containing("[job] cut stopped because hex moved from twin-x to")]);
  const lost: unknown[] = told("%[job] lost stopped%");
  expect(lost).toEqual([
    containing(
      "[job] lost stopped because dead-x went down, and started over from the beginning as hex started again on",
    ),
  ]);
});

test("a job that ended isn't started again from a stale copy of its record, nor started while it runs on the other machine, and one started from the machine hex left keeps its piped prompt", () => {
  const jobs = join(home, "state/jobs");
  rmSync(jobs, { recursive: true, force: true });
  run(["done2", "make", "all"], session);
  const copy = readFileSync(join(jobs, "done2.json"), "utf-8");
  end("done2", finishedByItself);
  writeFileSync(join(jobs, "done2.json"), copy);
  new Database(join(home, "state/hex.db")).run("delete from seen");

  expect(resume(join(home, "claude")).has("done2")).toBe(false);
  expect(existsSync(join(jobs, "done2.json"))).toBe(false);

  writeFileSync(
    join(jobs, "elsewhere2.json"),
    JSON.stringify({
      owner: "t3:stray-key",
      cwd: home,
      properties: [],
      command: ["make"],
      machine: "twin-x",
    }),
  );
  writeFileSync(join(home, "twin-active.txt"), "elsewhere2\n");

  const twice = Bun.spawnSync(["bun", job, "elsewhere2", "make", "all"], {
    env: { ...fakes(), ...session },
    cwd: home,
    stderr: "pipe",
  });

  expect(twice.exitCode).toBe(1);
  expect(twice.stderr.toString()).toContain("already runs on twin-x");

  mkdirSync(join(home, "xdg/hex"), { recursive: true });
  writeFileSync(marker, "twin-x\n");
  rmSync(launches, { force: true });

  const piped = Bun.spawnSync(["bun", job, "prompted", "claude", "-p", "--model", "opus"], {
    env: { ...fakes(), ...session },
    cwd: home,
    stdin: Buffer.from("Build the Usage tab.\n"),
  });

  rmSync(marker);
  expect(piped.exitCode).toBe(0);
  expect(existsSync(join(home, "twin/jobs/prompted.json"))).toBe(true);

  const launched = Args.parse(
    JSON.parse(readFileSync(launches, "utf-8").trim().split("\n").at(-1) ?? "[]"),
  );

  expect(Buffer.from(value(launched, "StandardInputData") ?? "", "base64").toString()).toBe(
    "Build the Usage tab.\n",
  );
});
