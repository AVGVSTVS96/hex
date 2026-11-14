import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exited, jobOf, lastWords, run } from "./beside.ts";
import { open } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beside-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a run's last words are what it printed last, on either stream, and its log goes once read", async () => {
  const log = join(dir, "run.log");

  const code = await run(
    ["sh", "-c", 'echo "API Error: Connection refused"; echo warning >&2; exit 1'],
    {
      cwd: dir,
      env: {},
      log,
    },
  );

  expect(code).toBe(1);
  expect(lastWords(log)).toBe("API Error: Connection refused\nwarning");
  expect(existsSync(log)).toBe(false);
});

test("a run is waited on by its process id alone, as one another hub started is", async () => {
  const other = Bun.spawn(["sleep", "30"]);
  let ended = false;

  const waiting = (async () => {
    await exited(other.pid);
    ended = true;
  })();

  await Bun.sleep(100);
  expect(ended).toBe(false);
  other.kill();
  await waiting;
  expect(ended).toBe(true);
});

test("where tail can't wait on a process, a run isn't taken for ended", async () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tail"), "#!/bin/sh\necho 'tail: unrecognized option' >&2\nexit 1\n");
  chmodSync(join(bin, "tail"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;

  try {
    expect(await exited(process.pid)).toBe(false);
  } finally {
    process.env.PATH = path;
  }
});

function found<T>(value: T | null): T {
  if (value === null) {
    throw new Error("missing");
  }

  return value;
}

test("a run is named for its timed job, or the job whose report it is", () => {
  const store = open(dir);
  const row = { to: "beside:general", from: "job", author: "prompt" as const, body: "ended" };
  store.messages.deliver({ ...row, key: "job:mail@1", meta: { user: "job", job: "mail" } });
  store.messages.deliver({ ...row, key: "job:beat@1", meta: { schedule: "beat" } });
  expect(jobOf(found(store.messages.get("job:mail@1")))).toBe("mail");
  expect(jobOf(found(store.messages.get("job:beat@1")))).toBe("beat");
});

test("a run beside a thread that ended is dealt with once, not at every hub start", () => {
  const store = open(dir);
  const at = new Date(Date.now() - 60_000).toISOString();
  store.messages.deliver({
    key: "job:beat@1",
    to: "beside:general",
    from: "job",
    author: "prompt",
    body: "check",
    meta: { schedule: "beat" },
  });
  store.turns.turned("failed", true, at);
  store.messages.take("job:beat@1", "failed");
  expect(store.turns.unfinishedBeside([])).toEqual(["failed"]);
  expect(store.turns.besideEnded("failed").given.map((row) => row.key)).toEqual(["job:beat@1"]);
  expect(store.turns.unfinishedBeside([])).toEqual([]);
});
