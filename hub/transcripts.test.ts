import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as claude from "./claude.ts";
import type { Keep } from "./kept.ts";
import { file } from "./store.ts";
import type { Store } from "./store.ts";
import { objectStorage } from "./store/fake.ts";
import { recordsIn } from "./store/storage.ts";
import { client } from "./store/wire.ts";
import { sessionTranscripts } from "./transcripts.ts";
import { until } from "./until.ts";

const SESSION = "0b9a51a2-3c44-4f0e-9d3a-6f1f5f1f7a10";
const THREAD = "-100:7";

let dir: string;
let folder: string;
const configDirBefore = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcripts-"));
  folder = join(dir, "hex");
});

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = configDirBefore;
  rmSync(dir, { recursive: true, force: true });
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store every machine reaches, as a folder's store.json names one: the object's own code over a database in memory.
function storeElsewhere(): Store {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "store.json"), "{}");
  const storage = objectStorage();
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");
  const object = recordsIn(storage, state);

  return {
    ...client((call) => Promise.resolve(JSON.stringify(object.call(call).reply))),
    dir: state,
    claim: () => Promise.resolve(1),
    watch: () => () => {},
    synced: () => Promise.resolve(),
    read: () => Promise.resolve([]),
    copy: () => Promise.resolve(),
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A machine is its own Claude Code folder, and the hub on it knows the thread's session from the store. Claude Code's folder is the process's, so a test is on one machine at a time: whatever a hub does there is awaited before the next machine's.
function machine(name: string, store: Store, known: { session?: string; fork?: string } = {}) {
  const config = join(dir, name);
  process.env.CLAUDE_CONFIG_DIR = config;
  const transcripts = claude.transcriptsIn(folder);
  const path = (session = SESSION) => join(transcripts, `${session}.jsonl`);
  mkdirSync(transcripts, { recursive: true });
  let reaches = true;
  const kept: Keep = async (use, otherwise) => (reaches ? await use(store) : otherwise);

  return {
    path,
    cutOff: () => {
      reaches = false;
    },
    written: (session = SESSION) => readFileSync(path(session), "utf-8"),
    setAside: () => readdirSync(transcripts).filter((entry) => entry.includes(".superseded-")),
    hub: async () => {
      process.env.CLAUDE_CONFIG_DIR = config;
      reaches = true;
      await store.threads.keep("telegram", {
        [THREAD]: { name: "plants", session: SESSION, ...known },
      });

      const hub = sessionTranscripts({
        threads: {
          ids: () => [THREAD],
          current: () => known.session ?? SESSION,
          get: () => ({ name: "plants", session: SESSION, ...known }),
          cwd: () => folder,
        },
        kept,
      });

      await hub.land(THREAD);
    },
  };
}

const line = (said: string) => `${JSON.stringify({ type: "user", message: { content: said } })}\n`;

async function sizeIn(store: Store, session = SESSION) {
  return (await store.transcripts.end(session)).size;
}

test("a session carries on from another machine with what it wrote on the first, and back again", async () => {
  const store = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  const first = line("the plants are in the hall") + line("water them on Friday");
  writeFileSync(server.path(), `${first}{"type":"assist`);
  await server.hub();
  await until(async () => (await sizeIn(store)) === Buffer.byteLength(first));

  appendFileSync(server.path(), `ant"}\n`);
  await until(async () => (await sizeIn(store)) === Buffer.byteLength(server.written()));

  await twin.hub();
  expect(twin.written()).toBe(server.written());

  appendFileSync(twin.path(), line("and the fern on Monday"));
  await until(async () => (await sizeIn(store)) === Buffer.byteLength(twin.written()));

  await server.hub();
  expect(server.written()).toBe(twin.written());
  expect(server.setAside()).toHaveLength(1);
});

test("what a machine wrote after it lost the store is set aside once another machine has carried the session on", async () => {
  const store = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await sizeIn(store)) === Buffer.byteLength(server.written()));
  server.cutOff();
  appendFileSync(server.path(), line("written as it went down"));

  await twin.hub();
  appendFileSync(twin.path(), line("said to the twin"));
  await until(async () => (await sizeIn(store)) === Buffer.byteLength(twin.written()));

  await server.hub();
  expect(await sizeIn(store)).toBe(Buffer.byteLength(twin.written()));
  expect(server.written()).toBe(twin.written());
  const [aside = ""] = server.setAside();
  expect(readFileSync(join(server.path(), "..", aside), "utf-8")).toContain(
    "written as it went down",
  );
});

test("a line longer than a piece, in characters of several bytes, arrives as it was written, and so does the session a thread forks from", async () => {
  const store = storeElsewhere();
  const forkedFrom = "7c1d2e3f-0a1b-4c2d-8e3f-9a0b1c2d3e4f";
  const server = machine("server", store, { session: forkedFrom });
  const twin = machine("twin", store, { fork: forkedFrom });
  const long = line("é漢🌱".repeat(60_000)) + line("after it");
  writeFileSync(server.path(forkedFrom), long);
  await server.hub();
  await until(async () => (await sizeIn(store, forkedFrom)) === Buffer.byteLength(long));

  await twin.hub();
  expect(twin.written(forkedFrom)).toBe(long);
});

test("a store in the hex folder is sent nothing, since no other machine reaches it", async () => {
  const state = join(dir, "state");
  const { store } = file(state);
  const server = machine("server", store);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  expect(await sizeIn(store)).toBe(0);
});

test("a transcript growing wakes none of the store's watchers, as a record changing does", () => {
  const storage = objectStorage();
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");
  const object = recordsIn(storage, dir);

  const call = (domain: string, method: string, args: unknown[]) =>
    object.call(JSON.stringify({ domain, method, args }));

  const grown = call("transcripts", "append", [
    SESSION,
    { size: 0, tail: "" },
    [{ upto: 3, text: "{}\n" }],
    "t1",
  ]);

  expect(grown.reply).toEqual({ value: { size: 3, tail: "t1" } });
  expect(grown.wrote).toBe(false);

  expect(call("threads", "keep", ["telegram", { [THREAD]: { name: "plants" } }]).wrote).toBe(true);
});
