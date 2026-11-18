import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
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

import * as claude from "./claude.ts";
import { landed } from "./kept.ts";
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

function objectIn(state: string) {
  const storage = objectStorage();
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");

  return recordsIn(storage, state);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store every machine reaches, as a folder's store.json names one: the object's own code over a database in memory. ring: what its watchers hear when it answers again.
function storeElsewhere() {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "store.json"), "{}");
  const object = objectIn(state);
  const watching = new Set<() => void>();

  const store: Store = {
    ...client((call) => Promise.resolve(JSON.stringify(object.call(call).reply))),
    dir: state,
    claim: () => Promise.resolve(1),
    watch: (listener) => {
      watching.add(listener);

      return () => {
        watching.delete(listener);
      };
    },
    synced: () => Promise.resolve(),
    read: () => Promise.resolve([]),
    copy: () => Promise.resolve(),
  };

  return {
    store,
    ring: () => {
      for (const each of watching) {
        each();
      }
    },
  };
}

type Known = { session?: string; fork?: string; fresh?: boolean };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A machine is its own Claude Code folder, and the hub on it knows the thread's session from the store. Claude Code's folder is the process's, so a test is on one machine at a time: whatever a hub does there is awaited before the next machine's. hub: a hub starts there and a session of the thread starts under it, which answers whether the session can be resumed there.
function machine(name: string, store: Store, known: Known = {}) {
  const config = join(dir, name);
  process.env.CLAUDE_CONFIG_DIR = config;
  const transcripts = claude.transcriptsIn(folder);
  const path = (session = SESSION) => join(transcripts, `${session}.jsonl`);
  mkdirSync(transcripts, { recursive: true });
  let reaches = true;
  const kept: Keep = async (use, otherwise) => (reaches ? await use(store) : otherwise);

  return {
    path,
    transcripts,
    written: (session = SESSION) => readFileSync(path(session), "utf-8"),
    setAside: () => readdirSync(transcripts).filter((entry) => entry.includes(".set-aside-")),
    reaches: (now: boolean) => {
      reaches = now;
    },
    hub: async () => {
      process.env.CLAUDE_CONFIG_DIR = config;
      reaches = true;
      await store.threads.keep("telegram", {
        [THREAD]: {
          name: "plants",
          session: known.session ?? SESSION,
          ...(known.fork !== undefined && { fork: known.fork }),
        },
      });

      const whole = await sessionTranscripts({
        threads: {
          ids: () => [THREAD],
          current: () => known.session ?? SESSION,
          get: () => ({
            name: "plants",
            session: known.session ?? SESSION,
            ...(known.fork !== undefined && { fork: known.fork }),
          }),
          cwd: () => folder,
        },
        kept,
        fresh: () => known.fresh === true,
        machine: name,
      }).land(THREAD);

      await landed();

      return whole;
    },
  };
}

const line = (said: string) => `${JSON.stringify({ type: "user", message: { content: said } })}\n`;

async function copyIn(store: Store, session = SESSION) {
  let text = "";

  for (let size = 0; ;) {
    const page = await store.transcripts.since(session, size);
    const last = page.at(-1);

    if (last === undefined) {
      return text;
    }

    text += page.map((piece) => piece.text).join("");
    size = last.upto;
  }
}

test("a session carries on from another machine with what it wrote on the first, and back again", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  const first = line("the plants are in the hall") + line("water them on Friday");
  writeFileSync(server.path(), `${first}{"type":"assist`);
  expect(await server.hub()).toBe(true);
  await until(async () => (await copyIn(store)) === first);

  appendFileSync(server.path(), `ant"}\n`);
  await until(async () => (await copyIn(store)) === server.written());

  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(server.written());
  await until(async () => (await store.transcripts.end(SESSION)).by === "twin");

  appendFileSync(twin.path(), line("and the fern on Monday"));
  await until(async () => (await copyIn(store)) === twin.written());

  expect(await server.hub()).toBe(true);
  expect(server.written()).toBe(twin.written());
  expect(server.setAside()).toEqual([]);
});

test("what a machine wrote after it lost the store is kept beside the copy once another machine has carried the session on", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());
  server.reaches(false);
  appendFileSync(server.path(), line("written as it went down"));

  await twin.hub();
  appendFileSync(twin.path(), line("said to the twin"));
  await until(async () => (await copyIn(store)) === twin.written());

  expect(await server.hub()).toBe(true);
  expect(await copyIn(store)).toBe(twin.written());
  expect(server.written()).toBe(twin.written());
  const [aside = ""] = server.setAside();
  expect(readFileSync(join(server.transcripts, aside), "utf-8")).toContain(
    "written as it went down",
  );
});

test("a transcript changed in place on the machine whose copy it is starts the copy over, and keeps its next turn", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the sudo password is hunter2") + line("noted"));
  await server.hub();
  await until(async () => (await copyIn(store)).includes("hunter2"));

  writeFileSync(
    server.path(),
    line("the sudo password is [redacted]") + line("noted") + line("a turn after it"),
  );
  await until(async () => (await copyIn(store)) === server.written());

  expect(await server.hub()).toBe(true);
  expect(server.written()).toContain("a turn after it");
  expect(server.written()).not.toContain("hunter2");
  expect(server.setAside()).toEqual([]);

  await twin.hub();
  expect(twin.written()).toBe(server.written());
});

test("a file put back shorter on the machine whose copy it is gets the rest from the copy, which stays", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const whole = line("the plants are in the hall") + line("water them on Friday");
  writeFileSync(server.path(), whole);
  await server.hub();
  await until(async () => (await copyIn(store)) === whole);

  writeFileSync(server.path(), line("the plants are in the hall"));
  expect(await server.hub()).toBe(true);
  expect(server.written()).toBe(whole);
  expect(await copyIn(store)).toBe(whole);
  expect(server.setAside()).toEqual([]);
});

test("a send the store didn't take goes once the store answers again, with no further change to the file", async () => {
  const { store, ring } = storeElsewhere();
  const server = machine("server", store);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());

  server.reaches(false);
  appendFileSync(server.path(), line("said while the store was away"));
  await Bun.sleep(200);
  expect(await copyIn(store)).not.toContain("away");

  server.reaches(true);
  ring();
  await until(async () => (await copyIn(store)) === server.written());
});

test("a copy still short of its file is resumed nowhere else, and an older file there never takes its place", async () => {
  const { store } = storeElsewhere();
  const twin = machine("twin", store);
  const short = line("the plants are in the hall");
  const whole = short + line("water them on Friday");

  await store.transcripts.append(SESSION, await store.transcripts.end(SESSION), [], {
    tail: "",
    of: Buffer.byteLength(whole),
    by: "server",
  });

  expect(await twin.hub()).toBe(false);
  expect(existsSync(twin.path())).toBe(false);

  writeFileSync(twin.path(), short);
  expect(await twin.hub()).toBe(false);
  expect(twin.written()).toBe(short);
  expect(await store.transcripts.end(SESSION)).toMatchObject({ size: 0, by: "server" });

  writeFileSync(twin.path(), whole);
  expect(await twin.hub()).toBe(true);
  await until(async () => (await copyIn(store)) === whole);
});

test("a landing that can't write its file leaves the start to go on without it", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());
  chmodSync(twin.transcripts, 0o500);

  try {
    expect(await twin.hub()).toBe(true);
    expect(existsSync(twin.path())).toBe(false);
  } finally {
    chmodSync(twin.transcripts, 0o700);
  }
});

test("a line longer than a piece, in characters of several bytes, arrives as it was written, and so does the session a thread forks from", async () => {
  const { store } = storeElsewhere();
  const forkedFrom = "7c1d2e3f-0a1b-4c2d-8e3f-9a0b1c2d3e4f";
  const server = machine("server", store, { session: forkedFrom });
  const twin = machine("twin", store, { fork: forkedFrom });
  const long = line("é漢🌱".repeat(60_000)) + line("after it");
  writeFileSync(server.path(forkedFrom), long);
  await server.hub();
  await until(async () => (await copyIn(store, forkedFrom)) === long);

  await twin.hub();
  expect(twin.written(forkedFrom)).toBe(long);
});

test("a thread that starts every turn fresh sends nothing, and neither does a hex whose store is in its folder", async () => {
  const { store } = storeElsewhere();
  const dm = machine("server", store, { fresh: true });
  writeFileSync(dm.path(), line("the plants are in the hall"));
  await dm.hub();
  expect(await store.transcripts.end(SESSION)).toMatchObject({ size: 0, of: 0 });

  const inFolder = file(join(dir, "alone")).store;
  const alone = machine("alone", inFolder);
  writeFileSync(alone.path(), line("the plants are in the hall"));
  await alone.hub();
  expect(await inFolder.transcripts.end(SESSION)).toMatchObject({ size: 0, of: 0 });
});

test("a transcript growing wakes none of the store's watchers, as a record changing does", () => {
  const object = objectIn(dir);

  const call = (domain: string, method: string, args: unknown[]) =>
    object.call(JSON.stringify({ domain, method, args }));

  const grown = call("transcripts", "append", [
    SESSION,
    { size: 0, tail: "", of: 0, by: "" },
    [{ upto: 3, text: "{}\n" }],
    { tail: "t1", of: 3, by: "server" },
  ]);

  expect(grown.reply).toEqual({ value: { size: 3, tail: "t1", of: 3, by: "server" } });
  expect(grown.wrote).toBe(false);

  expect(call("threads", "keep", ["telegram", { [THREAD]: { name: "plants" } }]).wrote).toBe(true);
});
