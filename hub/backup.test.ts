import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backup, nightly } from "./backup.ts";
import { open } from "./store.ts";
import { until } from "./until.ts";

let dir: string;
let path: string | undefined;
let named: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-"));
  path = process.env.PATH;
  named = process.env.HEX_COMPUTER;
  open(dir).messages.deliver({
    key: "telegram:-100:42",
    to: "-100:7",
    from: "telegram",
    body: "remind me to water the plants",
    author: "owner",
    meta: { user: "victor" },
  });
});

afterEach(() => {
  process.env.PATH = path;

  if (named === undefined) {
    delete process.env.HEX_COMPUTER;
  } else {
    process.env.HEX_COMPUTER = named;
  }

  rmSync(dir, { recursive: true, force: true });
});

function fakeSprite(script = 'shift 4; HOME="$COMPUTER" exec "$@"') {
  const bin = join(dir, "bin");

  mkdirSync(join(dir, "computer"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "sprite"), `#!/bin/sh\nCOMPUTER=${join(dir, "computer")}\n${script}\n`);
  chmodSync(join(bin, "sprite"), 0o755);
  process.env.PATH = `${bin}:${path}`;

  return join(dir, "computer", "hex-backups");
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("it didn't fail");
}

const saved = (file: string) => {
  const copy = new Database(file, { readonly: true });
  const rows = copy.query("select body from messages").all();

  copy.close();

  return rows;
};

test("a backup is a whole copy of hex.db in state/backups, named for its day", async () => {
  await backup(dir, "2026-10-19");
  expect(readdirSync(join(dir, "backups"))).toEqual(["hex-2026-10-19.db"]);
  expect(saved(join(dir, "backups", "hex-2026-10-19.db"))).toEqual([
    { body: "remind me to water the plants" },
  ]);
});

test("the last seven days are kept, here and on the computer", async () => {
  const there = fakeSprite();

  for (let day = 10; day <= 19; day++) {
    await backup(dir, `2026-10-${day}`, "cloud");
  }

  const kept = Array.from({ length: 7 }, (_, index) => `hex-2026-10-${13 + index}.db`);
  expect(readdirSync(join(dir, "backups")).toSorted()).toEqual(kept);
  expect(readdirSync(there).toSorted()).toEqual(kept);
  expect(readFileSync(join(there, "hex-2026-10-19.db"))).toEqual(
    readFileSync(join(dir, "backups", "hex-2026-10-19.db")),
  );
});

test("a computer that can't take the copy fails the backup, and the copy stays here", async () => {
  fakeSprite('echo "sprite not found" >&2; exit 1');
  expect(await failure(backup(dir, "2026-10-19", "cloud"))).toContain(
    "cloud didn't take it: sprite not found",
  );
  expect(existsSync(join(dir, "backups", "hex-2026-10-19.db"))).toBe(true);
});

test("a computer that never answers fails the backup once its time is up", async () => {
  fakeSprite("sleep 60");
  expect(await failure(backup(dir, "2026-10-19", "cloud", 300))).toContain(
    "cloud didn't answer in",
  );
  expect(existsSync(join(dir, "backups", "hex-2026-10-19.db"))).toBe(true);
});

test("a computer that leaves its answer open fails the backup once its time is up", async () => {
  fakeSprite("sleep 60 & exit 0");
  expect(await failure(backup(dir, "2026-10-19", "cloud", 300))).toContain(
    "cloud didn't answer in",
  );
});

test("a copy cut off on the way never takes the day's name on the computer", async () => {
  const there = fakeSprite('shift 4; head -c 4096 | HOME="$COMPUTER" exec "$@"');
  expect(await failure(backup(dir, "2026-10-19", "cloud"))).toContain("cloud didn't take it");
  expect(readdirSync(there)).toEqual(["hex-2026-10-19.db.part"]);
});

test("a copy that arrives changed fails the backup", async () => {
  fakeSprite('shift 4; cat > /dev/null; echo "0000  hex-2026-10-19.db"');
  expect(await failure(backup(dir, "2026-10-19", "cloud"))).toContain(
    "the copy on cloud doesn't match hex.db's",
  );
});

test("the hub backs up the last night it missed at its start, and a failed one tells the main thread", async () => {
  fakeSprite('echo "no such sprite" >&2; exit 1');
  process.env.HEX_COMPUTER = "cloud";
  const stop = nightly(dir, dir, "general");

  const failed = await until(() =>
    open(dir)
      .messages.untaken()
      .find((row) => row.from === "backup"),
  );

  stop();
  const day = failed.key.slice("backup:failed@".length);
  expect(failed).toMatchObject({
    to: "beside:general",
    body: `[backup] hex couldn't back up state/hex.db for ${day}: cloud didn't take it: no such sprite. The next try is at 3:00.`,
  });
  expect(readdirSync(join(dir, "backups"))).toEqual([`hex-${day}.db`]);
});
