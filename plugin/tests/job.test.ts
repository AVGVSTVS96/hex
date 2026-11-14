import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
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
  writeFileSync(join(jobs, "atrium.log"), "before the machine went down\n");

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
  expect(readFileSync(join(jobs, "atrium.log"), "utf-8")).toBe("before the machine went down\n");
  expect(
    readdirSync(jobs)
      .filter((file) => file.endsWith(".json"))
      .toSorted(),
  ).toEqual(["atrium.json", "live.json"]);

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
