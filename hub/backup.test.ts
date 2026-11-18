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
import { file, unclaimed, UnreachedError } from "./store.ts";
import { objectStorage } from "./store/fake.ts";
import { pointedAt, served } from "./store/object.testing.ts";
import { remote } from "./store/remote.ts";
import { recordsIn } from "./store/storage.ts";
import { until } from "./until.ts";

let dir: string;
let path: string | undefined;
let named: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-"));
  path = process.env.PATH;
  named = process.env.HEX_COMPUTER;
  file(dir).messages.deliver({
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

const saved = (backedUp: string) => {
  const copy = new Database(backedUp, { readonly: true });
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
    file(dir)
      .messages.untaken()
      .find((row) => row.from === "backup"),
  );

  stop();
  const day = failed.key.slice("backup:failed@".length);
  expect(failed).toMatchObject({
    to: "beside:general",
    body: `[backup] hex couldn't back up its records for ${day}: cloud didn't take it: no such sprite. The next try is at 3:00.`,
  });
  expect(readdirSync(join(dir, "backups"))).toEqual([`hex-${day}.db`]);
});

test("a store that can't be reached leaves no backup file, and its failure goes to the hub's log when the store can't take it either", async () => {
  const away = join(dir, "away");
  mkdirSync(away);
  writeFileSync(
    join(away, "store.json"),
    JSON.stringify({
      url: "http://127.0.0.1:9",
      name: "hex",
      key: "a key long enough that nobody guesses it",
    }),
  );
  expect(await failure(backup(away, "2026-10-19"))).toContain("didn't answer");
  expect(readdirSync(join(away, "backups"))).toEqual([]);

  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (line: string | Uint8Array) => {
    logged.push(String(line));

    return true;
  };

  try {
    const stop = nightly(away, dir, "general");
    await until(() => logged.find((line) => line.includes("Telling the main thread failed too")));
    stop();
  } finally {
    process.stderr.write = write;
  }

  expect(readdirSync(join(away, "backups"))).toEqual([]);
});

const never = Promise.reject(new Error("no store.json"));

void never.catch(() => null);

async function thrown(pending: Promise<unknown>): Promise<Error | string> {
  try {
    await pending;
  } catch (error) {
    return error instanceof Error ? error : String(error);
  }

  return "it didn't throw";
}

const unprobed = {
  answerWithin: 200,
  firstRetry: 3_600_000,
  longestRetry: 3_600_000,
  heartbeat: 100,
};

const message = {
  key: "telegram:-100:43",
  to: "-100:7",
  from: "telegram",
  body: "and the docs",
  author: "owner",
};

test("a backup reads through a client of its own: another process's word that the object is down doesn't stop it, and its own failure tells no one", async () => {
  const at = join(dir, "object");
  mkdirSync(at);
  const storage = objectStorage();
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");
  recordsIn(storage, at).call(
    JSON.stringify({ domain: "messages", method: "deliver", args: [message] }),
  );

  const object = served(storage);
  pointedAt(at, object.url);
  writeFileSync(join(at, "store.down"), "another process found it down\n");

  try {
    expect(await thrown(remote(at, unprobed)?.messages.untaken() ?? never)).toBeInstanceOf(
      UnreachedError,
    );
    await backup(at, "2026-11-17");
    const copy = new Database(join(at, "backups", "hex-2026-11-17.db"), { readonly: true });
    expect(copy.query("select key from messages").all()).toEqual([{ key: message.key }]);
    copy.close();
  } finally {
    await object.stop();
  }

  rmSync(join(at, "store.down"));
  const gone = join(at, "gone");
  pointedAt(gone, "http://127.0.0.1:9");
  expect(await thrown(unclaimed(gone).messages.untaken())).toBeInstanceOf(UnreachedError);
  expect(existsSync(join(gone, "store.down"))).toBe(false);
});
