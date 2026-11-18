import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";

import { z } from "zod";

import * as claude from "./claude.ts";
import { landed } from "./kept.ts";
import type { Keep } from "./kept.ts";
import { file } from "./store.ts";
import type { Store } from "./store.ts";
import { UnreachedError } from "./store/errors.ts";
import { objectStorage } from "./store/fake.ts";
import { recordsIn } from "./store/storage.ts";
import { client } from "./store/wire.ts";
import { sent, sessionTranscripts } from "./transcripts.ts";
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

const Call = z.object({ domain: z.string(), method: z.string(), args: z.array(z.unknown()) });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store every machine reaches, as a folder's store.json names one: the object's own code over a database in memory. ring: what its watchers hear when it answers again. net: what the way to it does to a call, by the call's name: drop it, take a while over it, or have the store refuse more of a file for want of room.
function storeElsewhere() {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "store.json"), "{}");
  const object = objectIn(state);
  const watching = new Set<() => void>();
  const net = { drops: (_call: string) => false, takes: 0, full: false };

  const store: Store = {
    ...client(async (text) => {
      const { domain, method, args } = Call.parse(JSON.parse(text));

      if (net.takes > 0) {
        await Bun.sleep(net.takes);
      }

      if (net.drops(`${domain}.${method}`)) {
        throw new UnreachedError("the store didn't answer");
      }

      return JSON.stringify(
        net.full && method === "append" && z.array(z.unknown()).parse(args[2]).length > 0
          ? { error: "hex's store keeps 5368709120 bytes of transcripts at most" }
          : object.call(text).reply,
      );
    }),
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
    net,
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

  const kept: Keep = async (use, otherwise) => {
    try {
      return reaches ? await use(store) : otherwise;
    } catch {
      return otherwise;
    }
  };

  const beside = (result: string, session = SESSION) =>
    join(transcripts, session, "tool-results", result);

  return {
    path,
    transcripts,
    beside,
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

      await sent();

      return whole;
    },
  };
}

const line = (said: string) => `${JSON.stringify({ type: "user", message: { content: said } })}\n`;

const endOf = (written: string) =>
  createHash("sha256").update(Buffer.from(written).subarray(-4096)).digest("hex");

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
    last: endOf(whole),
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

test("a file as long as the one a short copy is of, and not that file, is no whole conversation either", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  const first = line("the plants are in the hall");
  writeFileSync(server.path(), first);
  await server.hub();
  await until(async () => (await copyIn(store)) === first);

  server.reaches(false);
  appendFileSync(server.path(), line("water them on Friday"));
  const { size, ...told } = await store.transcripts.end(SESSION);

  await store.transcripts.append(SESSION, { size, ...told }, [], {
    ...told,
    of: Buffer.byteLength(server.written()),
    last: endOf(server.written()),
  });

  writeFileSync(twin.path(), first + line("said to the twin long ago"));
  expect(Buffer.byteLength(twin.written())).toBeGreaterThanOrEqual(
    Buffer.byteLength(server.written()),
  );
  expect(await twin.hub()).toBe(false);
  expect(await store.transcripts.end(SESSION)).toMatchObject({ size, by: "server" });
});

test("a machine holding an older file resumes nothing from it when the store doesn't say where the copy stands, or the copy can't be written there", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  const older = line("the plants are in the hall");
  writeFileSync(server.path(), older + line("water them on Friday"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());
  writeFileSync(twin.path(), older);

  net.drops = (call) => call.startsWith("transcripts.");
  expect(await twin.hub()).toBe(false);
  expect(twin.written()).toBe(older);

  net.drops = () => false;
  chmodSync(twin.transcripts, 0o500);

  try {
    expect(await twin.hub()).toBe(false);
    expect(twin.written()).toBe(older);
  } finally {
    chmodSync(twin.transcripts, 0o700);
  }

  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(server.written());
});

test("one call the store doesn't answer, of those that bring a copy, is asked again", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());

  for (const dropped of ["transcripts.end", "transcripts.since"]) {
    let once = true;

    net.drops = (call) => {
      const drops = once && call === dropped;
      once &&= !drops;

      return drops;
    };

    rmSync(twin.path(), { force: true });
    expect(await twin.hub()).toBe(true);
    expect(twin.written()).toBe(server.written());
  }
});

test("a store with no room left is still told how long a transcript has grown, so its copy is resumed nowhere else", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  const first = line("the plants are in the hall");
  writeFileSync(server.path(), first);
  await server.hub();
  await until(async () => (await copyIn(store)) === first);

  net.full = true;
  appendFileSync(server.path(), line("water them on Friday"));
  await until(async () => (await store.transcripts.end(SESSION)).of > Buffer.byteLength(first));
  appendFileSync(server.path(), line("and the fern on Monday"));

  await until(
    async () => (await store.transcripts.end(SESSION)).of === Buffer.byteLength(server.written()),
  );
  await sent();

  expect(await copyIn(store)).toBe(first);
  expect(await twin.hub()).toBe(false);
  expect(existsSync(twin.path())).toBe(false);
});

test("the store's other calls wait behind one piece of a long transcript, not the whole send, which a hub that stops waits for", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  writeFileSync(server.path(), line("x".repeat(100_000)).repeat(40));
  net.takes = 20;
  const hub = server.hub();
  await until(async () => (await store.transcripts.end(SESSION)).size > 0);

  const since = Date.now();
  await landed();
  expect(Date.now() - since).toBeLessThan(500);
  expect((await store.transcripts.end(SESSION)).size).toBeLessThan(
    Buffer.byteLength(server.written()),
  );

  await hub;
  expect((await store.transcripts.end(SESSION)).size).toBe(Buffer.byteLength(server.written()));
});

test("the tool results beside a transcript, text or not, come with it, and one that grew is sent again", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  const image = Buffer.from(Array.from({ length: 300_000 }, (_byte, at) => (at * 7) % 256));
  mkdirSync(dirname(server.beside("toolu_01.txt")), { recursive: true });
  writeFileSync(server.beside("toolu_01.txt"), "what the tool said, in full\n");
  writeFileSync(server.beside("shot-1.png"), image);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());

  writeFileSync(server.beside("toolu_01.txt"), "what the tool said, in full\nand its last line\n");
  appendFileSync(server.path(), line("water them on Friday"));
  await until(async () => (await copyIn(store)) === server.written());

  expect(await twin.hub()).toBe(true);
  expect(readFileSync(twin.beside("toolu_01.txt"), "utf-8")).toBe(
    "what the tool said, in full\nand its last line\n",
  );
  expect(readFileSync(twin.beside("shot-1.png")).equals(image)).toBe(true);
  expect(readdirSync(dirname(twin.beside("shot-1.png"))).toSorted()).toEqual([
    "shot-1.png",
    "toolu_01.txt",
  ]);

  await store.transcripts.append(
    `${SESSION}/tool-results/../../escaped`,
    await store.transcripts.end("nothing"),
    [{ upto: 1, text: "eA==" }],
    { tail: "t", of: 1, last: "", by: "server" },
  );
  rmSync(twin.beside("shot-1.png"));
  await server.hub();
  expect(await twin.hub()).toBe(true);
  expect(existsSync(join(twin.transcripts, "escaped"))).toBe(false);
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
    { size: 0, tail: "", of: 0, last: "", by: "" },
    [{ upto: 3, text: "{}\n" }],
    { tail: "t1", of: 3, last: "t1", by: "server" },
  ]);

  expect(grown.reply).toEqual({
    value: { size: 3, tail: "t1", of: 3, last: "t1", by: "server" },
  });
  expect(grown.wrote).toBe(false);

  expect(call("threads", "keep", ["telegram", { [THREAD]: { name: "plants" } }]).wrote).toBe(true);
});
