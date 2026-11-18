/* oxlint-disable unicorn/consistent-function-scoping -- dir is an import here, so a helper reading it looks like it captures nothing; each stays in the one test it serves */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  CHANNEL,
  SESSION,
  message,
  dir,
  hub,
  time,
  sleepers,
  start,
  calls,
  launched,
} from "./hub.testing.ts";
import { until } from "./until.ts";

test("a daemon that went down while General ran is started, so the hub finds General instead of starting a copy", async () => {
  writeFileSync(join(dir, "down"), "");
  await start({
    main: "chat",
    general: true,
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  await until(() => calls().some((each) => each[0] === "daemon" && each[1] === "run"));
  await time.lapse(1000);
  const run = calls().findIndex((each) => each[0] === "daemon" && each[1] === "run");
  expect(calls().slice(run + 1)).toContainEqual(["agents", "--json"]);
  expect(calls().filter((each) => each[0] !== "agents" && each[0] !== "daemon")).toEqual([]);
});

test("threads that start together while Claude's daemon is down start it once", async () => {
  writeFileSync(join(dir, "down"), "");
  writeFileSync(join(dir, "held"), "");

  const daemonRuns = () =>
    existsSync(join(dir, "daemon-runs"))
      ? readFileSync(join(dir, "daemon-runs"), "utf-8").length
      : 0;

  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await hub.deliver("chat:8", "Lamp", message);
  await hub.deliver("chat:9", "Shelf", message);

  await until(() => daemonRuns() > 0);
  await time.advance(10_000);
  expect(daemonRuns()).toBe(1);
  rmSync(join(dir, "held"));
});

test("a daemon left on an older claude is stopped with its sessions kept, so the session starts on a current one", async () => {
  writeFileSync(join(dir, "daemon"), "2.0.9");
  await start({ main: "chat", general: true });
  await launched();

  const daemon = calls()
    .filter((each) => each[0] === "daemon" || each[0] === "--bg")
    .map((each) => each.slice(0, 4).join(" "));

  expect(daemon.slice(-2)).toEqual([
    "daemon stop --any --keep-workers",
    `--bg --channels ${CHANNEL} --name`,
  ]);
});

test("a session's start checks the daemon while its old record is removed, so the wait for one doesn't add to the other", async () => {
  writeFileSync(join(dir, "slow"), "");
  await start({
    main: "chat",
    general: true,
    registry: { chat: { name: "hex", session: SESSION } },
  });
  await launched();

  const order = calls().map((each) => each[0]);

  expect(order.indexOf("--version")).toBeLessThan(order.indexOf("rm"));
});

test("a daemon on the claude that's installed is left running", async () => {
  await start({ main: "chat", general: true });
  await launched();
  expect(calls().some((each) => each[0] === "daemon" && each[1] === "stop")).toBe(false);
});

async function daemonWithPath(ours: string, theirs: string) {
  const daemon = Bun.spawn(["sleep", "60"], { env: { PATH: `${theirs}:${process.env.PATH}` } });

  sleepers.push(daemon);
  writeFileSync(join(dir, "daemon.pid"), String(daemon.pid));
  const path = process.env.PATH;
  process.env.PATH = `${ours}:${path}`;

  try {
    await start({ main: "chat", general: true });
    await launched();
  } finally {
    process.env.PATH = path;
  }

  return calls().some((each) => each[0] === "daemon" && each[1] === "stop");
}

function commandsIn(name: string, commands: string[]) {
  const directory = join(dir, name);

  mkdirSync(directory);

  for (const command of commands) {
    writeFileSync(join(directory, command), "");
  }

  return directory;
}

function linkTo(name: string, target: string) {
  symlinkSync(target, join(dir, name));

  return join(dir, name);
}

test("a daemon whose PATH finds the same commands is left running, though through another directory", async () => {
  const node = commandsIn("node-24", ["node"]);

  expect(await daemonWithPath(linkTo("ours", node), linkTo("theirs", node))).toBe(false);
});

test("a daemon whose PATH lacks a command the hub's finds is stopped with its sessions kept", async () => {
  const ours = commandsIn("ours", ["only-here"]);

  expect(await daemonWithPath(ours, commandsIn("theirs", []))).toBe(true);
});

test("a daemon whose PATH finds another copy of a command than the hub's is stopped with its sessions kept", async () => {
  expect(await daemonWithPath(commandsIn("ours", ["node"]), commandsIn("theirs", ["node"]))).toBe(
    true,
  );
});
