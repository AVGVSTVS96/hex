import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { clients } from "./apps.ts";
import {
  CHANNEL,
  heard,
  SESSION,
  message,
  dir,
  hub,
  failures,
  prompts,
  start,
  launched,
  session,
  http,
  sendToHub,
  saved,
  settingsOf,
  besideLauncher,
  runs,
} from "./hub.testing.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

function timed(key: string, more: Record<string, string> = {}, schedule = "heartbeat") {
  file(dir).messages.deliver({
    key,
    to: "beside:general",
    from: "schedule",
    author: "prompt",
    body: `[${schedule}] Hourly check`,
    meta: { user: "schedule", schedule, ...more },
  });
}

test("a timer beside General runs in a session of its own, as hex in General's chat, and General's session never hears it", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  const general = await session("general");
  timed("schedule:heartbeat@1");
  const run = await until(() => runs()[0]);
  const args = run?.args ?? [];
  expect(args.slice(0, 3)).toEqual(["-p", "--session-id", run?.beside ?? ""]);
  expect(args.at(-1)).toStartWith('<channel source="telegram" key="schedule:heartbeat@1"');
  expect(args.at(-1)).toContain("\n[heartbeat] Hourly check\n</channel>");
  const { env, enabledPlugins } = settingsOf(args);
  expect(enabledPlugins).toEqual({ "telegram@hex": true });
  expect(env).toMatchObject({ HEX_CHANNEL: CHANNEL, HEX_THREAD: "general", HEX_MAIN: "1" });
  expect(env.HEX_HUB).toBeUndefined();
  file(dir).messages.take("schedule:heartbeat@1", run?.beside ?? "");
  writeFileSync(join(dir, "go"), "0");
  await Bun.sleep(200);
  expect(general.received).toEqual([]);
  expect(failures).toEqual([]);
  expect(runs()).toHaveLength(1);
});

test("a session beside a thread speaks in its chat as itself, and is neither its inbound line nor its permission relay", async () => {
  await start({
    main: "general",
    general: true,
    call: async (thread) => {
      await hub.sent(thread, { content: "The landlord wrote." });

      return "sent";
    },
  });
  await launched();
  const general = await session("general");
  const beside = http("general", { "x-hex-beside": "beside-1" });
  await beside.initialize();
  await beside.open();
  await beside.rpc("tools/list");
  await beside.call("reply", { text: "The landlord wrote." });
  await beside.ask({
    request_id: "abcde",
    tool_name: "Bash",
    description: "ls",
    input_preview: "{}",
  });
  await hub.deliver("general", "hex", { ...message, content: "and now?" });
  await until(() => general.received.length);
  expect(heard(general.received).map((turn) => turn.content)).toEqual(["and now?"]);
  expect(beside.received).toEqual([]);
  expect(prompts).toEqual([]);
  expect(
    file(dir)
      .messages.said("general")
      .find((row) => row.body === "The landlord wrote.")?.taken?.by,
  ).toBe("beside-1");
});

const aTurnGoesThrough = () => sendToHub({ type: "state", thread: "chat:7", busy: false });

function takes(key: string, by: string) {
  const store = file(dir);
  store.turns.turned(by, true, new Date(Date.now() - 1000).toISOString());
  store.messages.take(key, by);
}

async function seesThrough(by: string) {
  await Bun.sleep(2);
  file(dir).turns.handled(by);
}

const ranFor = (key: string) =>
  until(() => runs().find((run) => run.args.at(-1)?.includes(`key="${key}"`) === true));

const CARRIES_ON = "\nIt carries on once turns go through again.";

test("a run beside a thread that never takes its row waits for a turn to go through, its chat hearing once, then is left if it fails again", async () => {
  writeFileSync(join(dir, "go"), "1");
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  await until(() => failures.length);
  expect(failures).toEqual([
    ["general", `[heartbeat] ran beside this chat and failed: exit 1${CARRIES_ON}`],
  ]);
  expect(file(dir).messages.get("schedule:heartbeat@1")?.meta?.stalled).toBeString();
  await Bun.sleep(200);
  expect(runs()).toHaveLength(1);
  await aTurnGoesThrough();
  await until(() => failures.length === 2);
  expect(runs()).toHaveLength(2);
  expect(failures[1]).toEqual([
    "general",
    "[heartbeat] failed again beside this chat, so it won't run by itself again: exit 1",
  ]);
  expect(file(dir).messages.get("schedule:heartbeat@1")?.taken?.by).toBe("hub");
});

test("runs beside a thread the API refused tell its chat once, in the API's words, then carry on one for each turn that goes through", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  timed("schedule:catch-up@1", {}, "catch-up");
  takes("schedule:heartbeat@1", (await ranFor("schedule:heartbeat@1")).beside);
  takes("schedule:catch-up@1", (await ranFor("schedule:catch-up@1")).beside);
  writeFileSync(join(dir, "said"), "API Error: Connection refused");
  writeFileSync(join(dir, "go"), "1");
  await until(() => failures.length);
  await until(() =>
    ["schedule:heartbeat@1", "schedule:catch-up@1"].every(
      (key) => file(dir).messages.get(key)?.meta?.stalled !== undefined,
    ),
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.[1]).toMatch(
    /^\[(heartbeat|catch-up)\] ran beside this chat and failed: API Error: Connection refused\nIt carries/u,
  );
  rmSync(join(dir, "go"));
  rmSync(join(dir, "said"));
  await aTurnGoesThrough();
  const third = await until(() => runs()[2]);
  expect(third.args.slice(0, 2)).toEqual(["-p", "--session-id"]);
  expect(third.args.at(-1)).toContain('key="schedule:heartbeat@1"');
  expect(third.args.at(-1)).not.toContain("stalled");
  await aTurnGoesThrough();
  await Bun.sleep(200);
  expect(runs()).toHaveLength(3);
  takes("schedule:heartbeat@1", third.beside);
  await seesThrough(third.beside);
  writeFileSync(join(dir, "go"), "0");
  const fourth = await until(() => runs()[3]);
  expect(fourth.args.at(-1)).toContain('key="schedule:catch-up@1"');
});

test("runs beside a thread that wait for a turn to go through still wait after a hub restart, and a timed one a newer run of its job will do is left to it", async () => {
  const stalled = { stalled: "2026-01-01T00:00:00.000Z" };
  timed("schedule:catch-up@1", stalled, "catch-up");
  timed("schedule:heartbeat@1", stalled);
  timed("schedule:catch-up@2", stalled, "catch-up");
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  await Bun.sleep(200);
  expect(runs()).toEqual([]);
  expect(failures).toEqual([]);
  await aTurnGoesThrough();
  const run = await until(() => runs()[0]);
  expect(run.args.at(-1)).toContain('key="schedule:heartbeat@1"');
  expect(file(dir).messages.get("schedule:catch-up@1")?.taken?.by).toBe("hub");
  expect(file(dir).messages.get("schedule:catch-up@2")?.taken).toBeUndefined();
});

test("a run beside a thread cut off with the machine, mid-turn or as its turn failed, runs again as the hub starts, even before Claude's daemon answers, and the logs of ended runs go", async () => {
  const store = file(dir);
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  timed("schedule:once@1", {}, "once");
  timed("schedule:twice@1", {}, "twice");
  store.turns.turned("dead-beside", true, minuteAgo);
  store.messages.take("schedule:once@1", "dead-beside");
  store.turns.turned("failed-beside", true, minuteAgo);
  store.messages.take("schedule:twice@1", "failed-beside");
  store.turns.turned("failed-beside", false, new Date().toISOString());
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", "beside-dead-beside.log"), "API Error");
  writeFileSync(join(dir, "down"), "");
  await start({
    main: "general",
    general: true,
    launcher: besideLauncher(),
    registry: { general: { name: "General", session: SESSION } },
  });
  expect((await ranFor("schedule:once@1")).beside).not.toBe("dead-beside");
  expect((await ranFor("schedule:twice@1")).beside).not.toBe("failed-beside");
  expect(existsSync(join(dir, "sessions", "beside-dead-beside.log"))).toBe(false);
  expect(failures).toEqual([]);
});

test("a client that shows only its own turns can't be spoken into from beside, so its thread takes the row", async () => {
  clients.set("telegram", { hub, waits: true, place: () => Promise.reject(new Error("no")) });

  try {
    await start({ main: "general", general: true, launcher: besideLauncher() });
    await launched();
    timed("schedule:heartbeat@1");
    await until(() => file(dir).messages.get("schedule:heartbeat@1")?.to === "general");
    expect(runs()).toEqual([]);
  } finally {
    clients.delete("telegram");
  }
});

test("a job's news for a session beside a thread resumes that session once its run is over", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  const first = await until(() => runs()[0]);
  file(dir).messages.take("schedule:heartbeat@1", first.beside);
  file(dir).messages.deliver({
    key: "job:mail@1",
    to: first.beside,
    from: "job",
    author: "prompt",
    body: "[job] mail ended: success (exit 0).",
    meta: { user: "job" },
  });
  await Bun.sleep(100);
  expect(runs()).toHaveLength(1);
  saved(first.beside);
  writeFileSync(join(dir, "go"), "0");
  const second = await until(() => runs()[1]);
  expect(second.beside).toBe(first.beside);
  expect(second.args.slice(0, 3)).toEqual(["-p", "--resume", first.beside]);
  expect(second.args.at(-1)).toContain('key="job:mail@1"');
});

test("a job's news for a session beside a thread whose conversation this machine doesn't have starts a new session for it", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  const first = await until(() => runs()[0]);
  file(dir).messages.take("schedule:heartbeat@1", first.beside);
  file(dir).messages.deliver({
    key: "job:mail@1",
    to: first.beside,
    from: "job",
    author: "prompt",
    body: "[job] mail ended: success (exit 0).",
    meta: { user: "job" },
  });
  writeFileSync(join(dir, "go"), "0");
  const second = await until(() => runs()[1]);
  expect(second.beside).not.toBe(first.beside);
  expect(second.args.slice(0, 3)).toEqual(["-p", "--session-id", second.beside]);
  expect(second.args.at(-1)).toContain('key="job:mail@1"');
});
