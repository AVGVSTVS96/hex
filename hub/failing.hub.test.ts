/* oxlint-disable unicorn/consistent-function-scoping -- dir is an import here, so a helper reading it looks like it captures nothing; each stays in the one test it serves */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import * as claude from "./claude.ts";
import {
  settled,
  heard,
  matching,
  SESSION,
  message,
  SERVER,
  dir,
  hub,
  states,
  failures,
  time,
  listener,
  inbound,
  start,
  bgStarts,
  deskStarts,
  startedAgainFor,
  respawns,
  restsOf,
  calls,
  launched,
  session,
  bound,
  job,
  settingsOf,
  slowLauncher,
  besideLauncher,
  runs,
} from "./hub.testing.ts";
import { startHub } from "./hub.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("a launcher that can't run fails the start instead of leaving it hanging", async () => {
  await start({ launcher: join(dir, "missing") });
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures[0]?.[0]).toBe("chat:7");
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
});

test("a session that fails to start is reported with its reason, and the next message retries", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "exit 1 before init"]]);
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
});

test("a start that throws before its session launches is a failed start for its thread, not an error for whoever asked for it", async () => {
  await start();
  const push = states.push.bind(states);

  states.push = () => {
    states.push = push;

    throw new Error("the chat can't be shown as working");
  };

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "the chat can't be shown as working"]]);
  expect(bgStarts()).toEqual([]);
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
});

test("a start that fails stops watching its job record", async () => {
  const { watchJob } = claude;
  const watches: unknown[] = [];

  const watching = spyOn(claude, "watchJob").mockImplementation((id, change) => {
    const opened = watchJob(id, change);
    const close = opened.close.bind(opened);
    watches.push(opened);

    opened.close = () => {
      watches.splice(watches.indexOf(opened), 1);
      close();
    };

    return opened;
  });

  try {
    await start();
    await hub.deliver("chat:7", "Desk anchors", message);
    await launched();
    expect(watches.length).toBe(1);
    await job("job12345", { state: "failed", detail: "exit 1 before init" });
    await until(() => failures.length);
    expect(watches).toEqual([]);
  } finally {
    watching.mockRestore();
  }
});

test("a start that fails before its session launches, as on a settings file it can't write, is reported, and the next message starts it", async () => {
  await start();
  const settings = join(dir, "sessions", "chat%3A7.json");
  mkdirSync(settings);
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", matching(/chat%3A7\.json/u)]]);
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
  expect(bgStarts()).toEqual([]);
  rmSync(settings, { recursive: true });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await launched();
});

test("a start still under way when its thread closes doesn't fail the thread's next start when it fails", async () => {
  await start({ launcher: slowLauncher() });
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => existsSync(join(dir, "start1")));
  void hub.retire("chat:7");
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => existsSync(join(dir, "start2")));
  writeFileSync(join(dir, "go1"), "claude: the daemon stopped answering");
  writeFileSync(join(dir, "go2"), "");
  await launched();
  const { received } = await session("chat:7");
  await until(() => heard(received).some((each) => each.content === "again"));
  expect(failures).toEqual([]);
});

test("a thread whose session failed to start starts again once another session connects, and gets the message that waited", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "daemon binary was deleted (upgrade in progress)" }),
  );
  await until(() => failures.length);
  writeFileSync(join(dir, "jobs", "job12345", "state.json"), JSON.stringify({ state: "working" }));
  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  expect(settingsOf(await until(() => bgStarts()[2])).env.HEX_THREAD).toBe("chat:7");
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
});

test("a thread opened with a prompt, or as a fork, whose start failed starts again with it once another session connects", async () => {
  await start();
  mkdirSync(join(dir, "work"));
  hub.open("chat:8", "OpenAI", "find the latest model", join(dir, "work"));
  hub.fork("chat:10", "Copy", SESSION, "carry on");
  await until(() => bgStarts().length === 2);
  await settled();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => failures.length === 2);
  writeFileSync(join(dir, "jobs", "job12345", "state.json"), JSON.stringify({ state: "working" }));
  hub.open("chat:9", "Video clips");
  await until(() => bgStarts().length === 3);
  await session("chat:9", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => bgStarts().length === 5);

  expect(startedAgainFor("chat:8").at(-1)).toBe("find the latest model");
  expect(hub.cwd("chat:8")).toBe(join(dir, "work"));
  expect(startedAgainFor("chat:10").slice(5, 8)).toEqual(["--resume", SESSION, "--fork-session"]);
  expect(startedAgainFor("chat:10").at(-1)).toBe("carry on");
});

test("a thread whose starts keep failing says so in its chat with each message, and hex beside General hears of it once, at the third", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  const general = await session("general");
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3, 4]) {
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: `try ${n}` });
    await until(() => restsOf("chat:7") === n);
  }

  expect(failures).toEqual(Array.from({ length: 4 }, () => ["chat:7", "exit 1 before init"]));
  const run = await until(() => runs()[0]);
  expect(run.args.at(-1)).toContain(
    '[hub] hex couldn\'t start the session of telegram thread "Desk anchors" 3 times in a row: exit 1 before init. Its next message starts it again.',
  );
  expect(runs()).toHaveLength(1);
  expect(general.received).toEqual([]);
});

test("General hears of a thread that keeps failing once its hub is there, even when that's after the third", async () => {
  await start();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3]) {
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: `try ${n}` });
    await until(() => restsOf("chat:7") === n);
  }

  mkdirSync(join(dir, "general"));

  const general = await startHub({
    stateDir: join(dir, "general"),
    storeDir: dir,
    channel: "plugin:discord@hex",
    server: SERVER,
    port: listener.port,
    main: "general",
    general: true,
    call: () => Promise.resolve(""),
    state: () => {},
    failed: () => {},
    hexDir: join(dir, "hex"),
  });

  try {
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: "try 4" });
    await until(() => restsOf("chat:7") === 4);
    await until(() => file(dir).messages.untaken("beside:general").length);
    expect(
      file(dir)
        .messages.untaken("beside:general")
        .map((row) => row.body),
    ).toEqual([
      '[hub] hex couldn\'t start the session of telegram thread "Desk anchors" 4 times in a row: exit 1 before init. Its next message starts it again.',
    ]);
  } finally {
    general.close();
  }
});

test("General whose start failed starts again with each next message, as its heartbeat, says so in its chat each time, and leaves itself no message", async () => {
  await start({ main: "general", general: true });
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3]) {
    if (n > 1) {
      await hub.deliver("general", "hex", { ...message, content: `try ${n}` });
    }

    await until(() => restsOf("general") === n);
    expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(n);
  }

  expect(failures).toEqual(Array.from({ length: 3 }, () => ["general", "exit 1 before init"]));
  expect(
    file(dir)
      .messages.untaken("general")
      .map((row) => row.body),
  ).toEqual(["try 2", "try 3"]);
});

test("a thread whose start fails even once another session started is left to its own next message, and its chat hears only of that", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *chat%3A7*) echo try >> "${dir}/tries"; echo 'its folder is gone'; exit 1;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  await start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  const openai = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  openai.close();
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  hub.open("chat:9", "Video clips");
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  await session("chat:9", "2c3d4e5f-0000-4000-8000-000000000000");
  await Bun.sleep(100);
  expect(tries()).toBe(2);
  expect(failures).toEqual([["chat:7", "its folder is gone"]]);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => tries() === 3);
  await until(() => failures.length === 2);
});

test("a thread whose messages keep failing to start gets a retry for each, so it starts once starts go through", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(join(dir, "broken"), "");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *chat%3A7*) if [ -e "${dir}/broken" ]; then echo try >> "${dir}/tries"; echo 'its folder is gone'; exit 1; fi;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  await start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => failures.length === 2);
  rmSync(join(dir, "broken"));
  hub.open("chat:9", "Video clips");
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  await session("chat:9", "2c3d4e5f-0000-4000-8000-000000000000");
  await until(() => deskStarts().length === 1);
  expect(tries()).toBe(3);
});

test("a message that arrives while a retry starts makes the retry its own, so its chat hears if that start fails", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *chat%3A7*) echo try >> "${dir}/tries"; if [ "$(wc -l < "${dir}/tries")" -ge 2 ]; then while [ ! -e "${dir}/go" ]; do sleep 0.02; done; fi; echo 'its folder is gone'; exit 1;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  await start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  const connected = session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  writeFileSync(join(dir, "go"), "");
  await connected;
  await until(() => failures.length === 2);
  expect(failures).toEqual([
    ["chat:7", "its folder is gone"],
    ["chat:7", "its folder is gone"],
  ]);
  expect(tries()).toBe(2);
});

test("a fork whose session runs without its channel starts again into that session, not a second copy", async () => {
  const FORKED = "2c3d4e5f-0000-4000-8000-000000000000";
  bound("chat:10", FORKED);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: FORKED, pid: 42, startedAt: 1 }]),
  );
  await start({ reconnect: 50 });
  hub.fork("chat:10", "Copy", SESSION, "carry on");
  await time.lapse(50);
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:10", "its session runs, but its channel never connects"]);
  hub.open("chat:9", "Video clips");
  await until(() => bgStarts().length === 2);
  await session("chat:9", "1b2c3d4e-0000-4000-8000-000000000000");
  await time.lapse(50);
  await time.lapse(50);
  expect(states.filter(([thread, busy]) => thread === "chat:10" && !busy)).toHaveLength(2);
  expect(bgStarts()).toHaveLength(2);
  expect(calls().filter((each) => each[0] === "respawn")).toHaveLength(2);
});

test("a thread whose session runs without its channel is retried once, not each time another session starts", async () => {
  const STUCK = "2c3d4e5f-0000-4000-8000-000000000000";
  bound("chat:10", STUCK);
  writeFileSync(join(dir, "agents"), JSON.stringify([{ sessionId: STUCK, pid: 42, startedAt: 1 }]));
  await start({ reconnect: 50 });
  await hub.deliver("chat:10", "Stuck", message);
  await time.lapse(50);
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:10", "its session runs, but its channel never connects"]);
  hub.open("chat:8", "OpenAI");
  await until(() => calls().filter((each) => each[0] === "--bg").length === 1);
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await time.lapse(50);
  await time.lapse(50);
  expect(states.filter(([thread, busy]) => thread === "chat:10" && !busy)).toHaveLength(2);

  const resumed: [string, string][] = [
    ["chat:9", "3d4e5f60-0000-4000-8000-000000000000"],
    ["chat:11", "4e5f6071-0000-4000-8000-000000000000"],
  ];

  for (const [thread, id] of resumed) {
    hub.open(thread, thread);
    await until(() =>
      calls().some(
        (each) => each[0] === "--bg" && each.join(" ").includes(encodeURIComponent(thread)),
      ),
    );
    await session(thread, id);
  }

  await time.advance(300);
  expect(respawns()).toHaveLength(2);
  expect(failures).toHaveLength(1);
});

test("the owner's stop ends a thread's run of failed starts, so another session connecting doesn't start it again", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => failures.length);
  writeFileSync(join(dir, "jobs", "job12345", "state.json"), JSON.stringify({ state: "working" }));
  await hub.stop("chat:7");
  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await Bun.sleep(100);
  expect(bgStarts()).toHaveLength(2);
});

test("a session that connects ends the watch, so a later failed state is ignored", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await session("chat:7");
  await job("job12345", { state: "failed", detail: "later" });
  expect(failures).toEqual([]);
});

test("a main thread whose new session ends before its channel connects is reported and started again", async () => {
  await start({ main: "chat", agents: [], reconnect: 50 });
  expect(settingsOf(await launched()).env.HEX_MAIN).toBeUndefined();
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat", "its session ended before its channel connected"]);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
});

test("a thread whose new session ends before its channel connects is reported, and its next message starts it again", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session ended before its channel connected"]);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  const { received } = await session("chat:7");
  await until(() => received.length === 2);
  expect(heard(received).map((m) => m.content)).toEqual(["hi", "again"]);
});

test("a session that restarts in place and then ends is reported, and the thread starts again on its next message", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  close();
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  writeFileSync(join(dir, "agents"), "[]");
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session ended before its channel connected"]);
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
});
