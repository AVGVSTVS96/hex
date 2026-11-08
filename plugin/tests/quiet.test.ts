import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../../hub/store.ts";

const HEX = join(import.meta.dir, "../..");
const home = mkdtempSync(join(tmpdir(), "quiet-"));
const sessions = join(home, "config/sessions");
const state = join(home, "state");
const store = open(state);

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(home, "config"),
  HEX_STORE: state,
  HEX_QUIET_MS: "100",
};

afterAll(() => {
  rmSync(home, { recursive: true });
});

const startQuiet = () => Bun.spawn([join(HEX, "bin/quiet")], { env, stdout: "pipe" });

test("bin/quiet waits while a session hex started is mid-turn, and not on other sessions or one whose turn ended since Claude Code called it busy", async () => {
  mkdirSync(sessions, { recursive: true });

  const status = (
    file: string,
    name: string,
    kind: string,
    turn: string,
    at = Date.now() - 1000,
  ) => {
    writeFileSync(
      join(sessions, file),
      JSON.stringify({
        pid: process.pid,
        sessionId: name,
        name,
        kind,
        status: turn,
        statusUpdatedAt: at,
      }),
    );
  };

  status("1.json", "ours", "bg", "busy");
  status("2.json", "theirs", "interactive", "busy");
  writeFileSync(
    join(sessions, "3.json"),
    JSON.stringify({ pid: 2 ** 22 + 1, sessionId: "gone", kind: "bg", status: "busy" }),
  );
  status("4.json", "agents", "bg", "busy");
  store.turns.turned("agents", true);
  store.turns.turned("agents", false);
  store.turns.turned("ours", true);
  store.turns.turned("unheard", true);
  store.turns.turned("unheard", false);
  status("5.json", "unheard", "bg", "busy", Date.now() + 1000);
  const quiet = Bun.spawn([join(HEX, "bin/quiet")], { env, stdout: "pipe" });
  await Bun.sleep(500);
  expect(quiet.exitCode).toBeNull();
  store.turns.turned("ours", false);
  await Bun.sleep(500);
  expect(quiet.exitCode).toBeNull();
  status("5.json", "unheard", "bg", "idle", Date.now());
  expect(await quiet.exited).toBe(0);
  expect(await new Response(quiet.stdout).text()).toBe(
    "waiting on: ours, unheard\nwaiting on: unheard\n",
  );
});

test("bin/quiet leaves out the turn of each session that asked for an update, not the turns after it", async () => {
  rmSync(sessions, { recursive: true, force: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "1.json"),
    JSON.stringify({
      pid: process.pid,
      sessionId: "asker",
      name: "asker",
      kind: "bg",
      status: "busy",
    }),
  );
  store.turns.turned("asker", true);
  await Bun.sleep(5);
  writeFileSync(
    join(sessions, "2.json"),
    JSON.stringify({
      pid: process.pid,
      sessionId: "later",
      name: "later",
      kind: "bg",
      status: "busy",
    }),
  );
  store.turns.turned("later", true);
  const first = startQuiet();
  await Bun.sleep(300);
  expect(first.exitCode).toBeNull();
  await Bun.sleep(5);
  writeFileSync(
    join(state, "update-askers"),
    `asker@${Date.now()} telegram:1 abc\nlater@${Date.now()} telegram:2 abc\n`,
  );
  expect(await first.exited).toBe(0);
  expect(await new Response(first.stdout).text()).toBe("waiting on: asker, later\n");
  await Bun.sleep(5);
  store.turns.turned("asker", true);
  const next = startQuiet();
  await Bun.sleep(500);
  expect(next.exitCode).toBeNull();
  next.kill();
});
