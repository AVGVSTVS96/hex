import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("HEX_") && !["CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR"].includes(name),
  ),
);

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
    "hub/store.ts",
    "hub/store",
    "hub/running.ts",
    "hub/claude.ts",
    "hub/until.ts",
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
    `#!/bin/sh\njq -cn '$ARGS.positional' --args -- "$@" > "${ran}"\n`,
  );
  chmodSync(join(home, "fake/systemd-run"), 0o755);
  writeFileSync(
    join(home, "fake/systemctl"),
    `#!/bin/sh
case "$1" in
  is-system-running) cat "${home}/system.txt" 2>/dev/null || echo running ;;
  --user) for unit; do :; done; grep -qx "$unit" "${home}/active.txt" 2>/dev/null ;;
esac
`,
  );
  chmodSync(join(home, "fake/systemctl"), 0o755);
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
      meta: JSON.stringify({ user: "job" }),
    },
    {
      to: "555",
      from: "job",
      body: containing("[job] older ended"),
      meta: JSON.stringify({ user: "job" }),
    },
    {
      to: "-100123:101",
      from: "job",
      body: containing("[job] topic ended"),
      meta: JSON.stringify({ user: "job" }),
    },
    {
      to: "-100123:909",
      from: "job",
      body: containing("[job] early ended"),
      meta: JSON.stringify({ user: "job" }),
    },
  ]);
});

test("a job that runs already is refused", () => {
  writeFileSync(join(home, "active.txt"), "busy\n");
  expect(run(["busy", "make"], session).code).toBe(1);
  rmSync(join(home, "active.txt"));
});

test("a job the machine going down stopped carries on as hex starts: a claude job in its own conversation, any other job told to its owner", () => {
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

  const end = (unit: string) =>
    Bun.spawnSync(["bun", job, "--ended", unit, "t3:stray-key"], {
      env: { ...env, PATH: `${join(home, "fake")}:${env.PATH}` },
    });

  end("make");
  expect(readFileSync(join(jobs, "make.json"), "utf-8")).toContain('"make","all"');
  rmSync(join(home, "system.txt"));
  writeFileSync(join(home, "state/moving"), "");
  end("make");
  expect(readFileSync(join(jobs, "make.json"), "utf-8")).toContain('"make","all"');
  rmSync(join(home, "state/moving"));
  rmSync(ran, { force: true });

  const resumed = Bun.spawnSync(["bun", job, "--resume"], {
    cwd: home,
    env: { ...env, PATH: `${join(home, "fake")}:${env.PATH}`, CLAUDE_CONFIG_DIR: config },
    stderr: "pipe",
  });

  expect(resumed.exitCode).toBe(0);
  const args = Args.parse(JSON.parse(readFileSync(ran, "utf-8")));
  expect(args).toContain("--unit=atrium");
  expect(args.slice(args.indexOf("--"), -1)).toEqual([
    "--",
    join(home, ".hex/bin/place"),
    "hex/atrium",
    "-p",
    "--model",
    "opus",
    "--resume",
    "s-1",
  ]);
  expect(args.at(-1)).toContain("carry on");
  expect(readdirSync(jobs).toSorted()).toEqual(["atrium.json", "live.json"]);

  const told: unknown[] = z
    .array(z.string())
    .parse(
      new Database(join(home, "state/hex.db"))
        .query(
          `select body from messages where "from" = 'job' and key like 'job:%:%' and (body like '%resumed%' or body like '%hasn''t run%') order by rowid`,
        )
        .values()
        .flat(),
    )
    .toSorted();

  expect(told).toEqual([
    containing("[job] atrium stopped when the machine went down, and resumed"),
    containing("[job] early stopped"),
    containing("[job] make stopped"),
  ]);
  rmSync(join(home, "active.txt"));
});
