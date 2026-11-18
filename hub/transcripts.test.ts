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
// A store every machine reaches, as a folder's store.json names one: the object's own code over a database in memory. ring: what its watchers hear when it answers again. net: what the way to it does to a call, by the call's name: drop it, take a while over it, or have the store refuse more of a file for want of room, which calls about transcripts it was asked, and how many calls were on their way at once.
function storeElsewhere() {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "store.json"), "{}");
  const object = objectIn(state);
  const watching = new Set<() => void>();

  const net = {
    drops: (_call: string) => false,
    dropped: 0,
    asked: new Array<string>(),
    takes: 0,
    full: false,
    out: 0,
    mostOut: 0,
  };

  const store: Store = {
    ...client(async (text) => {
      const { domain, method, args } = Call.parse(JSON.parse(text));

      net.out += 1;
      net.mostOut = Math.max(net.mostOut, net.out);

      try {
        if (net.takes > 0) {
          await Bun.sleep(net.takes);
        }
      } finally {
        net.out -= 1;
      }

      if (domain === "transcripts") {
        net.asked.push(method);
      }

      if (net.drops(`${domain}.${method}`)) {
        net.dropped += 1;

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

  const thread = () => ({
    name: "plants",
    session: known.session ?? SESSION,
    ...(known.fork !== undefined && { fork: known.fork }),
  });

  async function hubNow() {
    process.env.CLAUDE_CONFIG_DIR = config;
    reaches = true;
    await store.threads.keep("telegram", { [THREAD]: thread() });

    return sessionTranscripts({
      threads: {
        ids: () => [THREAD],
        current: () => known.session ?? SESSION,
        get: thread,
        cwd: () => folder,
      },
      kept,
      fresh: () => known.fresh === true,
      machine: name,
    });
  }

  return {
    path,
    transcripts,
    beside,
    written: (session = SESSION) => readFileSync(path(session), "utf-8"),
    setAside: () => readdirSync(transcripts).filter((entry) => entry.includes(".set-aside-")),
    reaches: (now: boolean) => {
      reaches = now;
    },
    hub: async (fork?: string) => {
      const hub = await hubNow();
      const whole = await hub.land(THREAD, fork);
      await sent();

      return whole;
    },
    started: async () => {
      const hub = await hubNow();
      await sent();

      return async () => {
        process.env.CLAUDE_CONFIG_DIR = config;
        const whole = await hub.land(THREAD);
        await sent();

        return whole;
      };
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

test("a transcript changed in place on the machine that holds hex leaves the copy as it was changed, keeps its next turn, and reaches a machine that held the older one with nothing kept aside", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the sudo password is hunter2") + line("noted"));
  await server.hub();
  await until(async () => (await copyIn(store)).includes("hunter2"));
  expect(await twin.hub()).toBe(true);

  writeFileSync(
    server.path(),
    line("the sudo password is [redacted]") + line("noted") + line("a turn after it"),
  );
  await until(async () => (await copyIn(store)) === server.written());

  expect(await server.hub()).toBe(true);
  expect(server.written()).toContain("a turn after it");
  expect(server.written()).not.toContain("hunter2");
  expect(server.setAside()).toEqual([]);

  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(server.written());
  expect(twin.setAside()).toEqual([]);
});

const SECRET = line("the sudo password is hunter2") + line("noted");
const REDACTED = line("the sudo password is [redacted]") + line("noted");
const [OLD, STRUCK] = ["the sudo password is hunter2\n", "the sudo password is [redacted]\n"];
const RESULT = "toolu_01.txt";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Both machines hold a session's conversation as the server wrote it, and the server holds hex, its hub watching.
async function bothHold(store: Store, said = SECRET) {
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), said);
  await server.hub();
  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(said);
  expect(await server.hub()).toBe(true);

  return { server, twin };
}

test("a secret taken out of a transcript on the machine that doesn't hold hex stays out there and in the store, and leaves the other machine's file at its next start", async () => {
  const { store } = storeElsewhere();
  const { server, twin } = await bothHold(store);
  expect(await store.transcripts.end(SESSION)).toMatchObject({ by: "server" });

  writeFileSync(twin.path(), REDACTED);
  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(REDACTED);
  expect(twin.setAside()).toEqual([]);
  expect(await copyIn(store)).toBe(REDACTED);

  expect(await server.hub()).toBe(true);
  expect(server.written()).toBe(REDACTED);
  expect(server.setAside()).toEqual([]);
});

test("a secret taken out of a transcript on the machine that doesn't hold hex stays out though the other machine wrote on meanwhile, and keeps those lines", async () => {
  const { store } = storeElsewhere();
  const { server, twin } = await bothHold(store);
  appendFileSync(server.path(), line("a turn on the server"));
  await until(async () => (await copyIn(store)) === server.written());

  writeFileSync(twin.path(), REDACTED);
  const both = REDACTED + line("a turn on the server");
  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(both);
  expect(await copyIn(store)).toBe(both);

  expect(await server.hub()).toBe(true);
  expect(server.written()).toBe(both);
  expect([...server.setAside(), ...twin.setAside()]).toEqual([]);
});

test("a secret taken out of a transcript with its length kept, far from its end, leaves the store", async () => {
  const { store } = storeElsewhere();
  const rest = line("x".repeat(3000)) + line("y".repeat(3000));
  const { server, twin } = await bothHold(store, line("the sudo password is hunter2456") + rest);

  writeFileSync(server.path(), line("the sudo password is [redacted]") + rest);
  expect(await server.hub()).toBe(true);
  expect(await copyIn(store)).toBe(server.written());

  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(server.written());
  expect(twin.setAside()).toEqual([]);
});

test("a transcript changed in place on both machines since they held the same ends as the store's, the other kept beside it", async () => {
  const { store } = storeElsewhere();
  const { server, twin } = await bothHold(store);
  writeFileSync(server.path(), REDACTED);
  await until(async () => (await copyIn(store)) === REDACTED);

  const other = line("the sudo password is hunter2") + line("struck out");
  writeFileSync(twin.path(), other);
  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(REDACTED);
  expect(await copyIn(store)).toBe(REDACTED);
  expect(
    twin.setAside().map((aside) => readFileSync(join(twin.transcripts, aside), "utf-8")),
  ).toEqual([other]);
});

test("a transcript rewritten while its send waited on the store is looked at again, so the copy is the file and not the old one's start with the new one's end", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  mkdirSync(dirname(server.beside(RESULT)), { recursive: true });
  writeFileSync(server.beside(RESULT), OLD);
  writeFileSync(server.path(), SECRET);
  await server.hub();
  expect(await copyIn(store)).toBe(SECRET);
  let rewrites = true;

  net.drops = (call) => {
    if (rewrites && call === "transcripts.append") {
      rewrites = false;
      writeFileSync(server.path(), REDACTED + line("a turn after it"));
    }

    return false;
  };

  writeFileSync(server.beside(RESULT), STRUCK);
  await until(() => !rewrites);
  await until(async () => (await copyIn(store)) === server.written());
  expect(server.written()).toBe(REDACTED + line("a turn after it"));
});

test("what a machine keeps of where a file and its copy agreed goes once no open thread is on the session", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const kept = join(dir, "state", "copies", "server", `${SESSION}.agreed`);
  writeFileSync(server.path(), SECRET);
  await server.hub();
  expect(readFileSync(kept, "utf-8")).toContain(String(Buffer.byteLength(SECRET)));

  const moved = machine("server", store, { session: "7c1d2e3f-0a1b-4c2d-8e3f-9a0b1c2d3e4f" });
  await moved.started();
  await until(() => !existsSync(kept));
});

async function sentBeforeDigests(store: Store, said: string, by: string) {
  await store.transcripts.append(
    SESSION,
    await store.transcripts.end(SESSION),
    [{ upto: Buffer.byteLength(said), text: said }],
    { tail: endOf(said), of: Buffer.byteLength(said), last: endOf(said), by },
  );
}

test("a copy sent before copies had digests reaches a machine that lacks it, and starts over from the file that holds its end", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  await sentBeforeDigests(store, SECRET, "server");

  expect(await twin.hub()).toBe(true);
  expect(twin.written()).toBe(SECRET);
  expect(await copyIn(store)).toBe(SECRET);
  expect(await store.transcripts.end(SESSION)).toMatchObject({ by: "twin" });

  expect(
    (await store.transcripts.marks(SESSION, 0)).map(({ upto, digest }) => [upto, digest]),
  ).toEqual([[Buffer.byteLength(SECRET), createHash("sha256").update(SECRET).digest("hex")]]);

  writeFileSync(server.path(), SECRET);
  expect(await server.hub()).toBe(true);
  expect(await store.transcripts.end(SESSION)).toMatchObject({ by: "twin" });
});

test("a copy sent before copies had digests completes its own machine's file when that is the copy cut short, and starts over from it when it was changed in place", async () => {
  const { store } = storeElsewhere();
  const server = machine("server", store);
  await sentBeforeDigests(store, SECRET, "server");

  writeFileSync(server.path(), line("the sudo password is hunter2"));
  expect(await server.hub()).toBe(true);
  expect(server.written()).toBe(SECRET);
  expect(await copyIn(store)).toBe(SECRET);

  const { digest: _since, ...before } = await store.transcripts.end(SESSION);
  const said = { tail: endOf(SECRET), of: Buffer.byteLength(SECRET), last: endOf(SECRET) };

  await store.transcripts.append(
    SESSION,
    before,
    [{ upto: Buffer.byteLength(SECRET), text: SECRET }],
    { ...said, by: "server" },
    true,
  );

  const other = machine("server", store);
  writeFileSync(other.path(), REDACTED);
  rmSync(join(dir, "state", "copies"), { recursive: true });
  expect(await other.hub()).toBe(true);
  expect(other.written()).toBe(REDACTED);
  expect(await copyIn(store)).toBe(REDACTED);
  expect(other.setAside()).toEqual([]);
});

async function besideIn(store: Store, name = RESULT) {
  const held = await store.transcripts.since(`${SESSION}/tool-results/${name}`, 0);

  return Buffer.concat(held.map(({ text }) => Buffer.from(text, "base64"))).toString("utf-8");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Both machines hold a session's conversation and one tool result beside it, as the server wrote them, and the server holds hex, its hub watching.
async function bothHoldBeside(store: Store) {
  const server = machine("server", store);
  const twin = machine("twin", store);
  mkdirSync(dirname(server.beside(RESULT)), { recursive: true });
  writeFileSync(server.beside(RESULT), OLD);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  expect(await twin.hub()).toBe(true);
  expect(readFileSync(twin.beside(RESULT), "utf-8")).toBe(OLD);
  expect(await server.hub()).toBe(true);

  return { server, twin };
}

test("a tool result changed on the machine that holds hex reaches the store with no line written after it, and the other machine at its next start", async () => {
  const { store } = storeElsewhere();
  const { server, twin } = await bothHoldBeside(store);
  writeFileSync(server.beside(RESULT), STRUCK);
  await until(async () => (await besideIn(store)) === STRUCK);

  expect(await twin.hub()).toBe(true);
  expect(readFileSync(twin.beside(RESULT), "utf-8")).toBe(STRUCK);
  expect(await server.hub()).toBe(true);
  expect(readFileSync(server.beside(RESULT), "utf-8")).toBe(STRUCK);
});

test("a tool result changed on a machine that lost hex before it could send it is the one both machines and the store end with", async () => {
  const { store } = storeElsewhere();
  const { server, twin } = await bothHoldBeside(store);
  server.reaches(false);
  writeFileSync(server.beside(RESULT), STRUCK);
  expect(await twin.hub()).toBe(true);
  expect(await besideIn(store)).toBe(OLD);

  expect(await server.hub()).toBe(true);
  expect(readFileSync(server.beside(RESULT), "utf-8")).toBe(STRUCK);
  expect(await besideIn(store)).toBe(STRUCK);
  expect(await twin.hub()).toBe(true);
  expect(readFileSync(twin.beside(RESULT), "utf-8")).toBe(STRUCK);
});

test("a tool result changed on the machine that doesn't hold hex is the one both machines and the store end with", async () => {
  const { store } = storeElsewhere();
  const { server, twin } = await bothHoldBeside(store);
  writeFileSync(twin.beside(RESULT), STRUCK);
  expect(await twin.hub()).toBe(true);
  expect(readFileSync(twin.beside(RESULT), "utf-8")).toBe(STRUCK);
  expect(await besideIn(store)).toBe(STRUCK);

  expect(await server.hub()).toBe(true);
  expect(readFileSync(server.beside(RESULT), "utf-8")).toBe(STRUCK);
});

test("a tool result that doesn't arrive as a machine takes hex over stays the store's newer one, and arrives once the store gives it", async () => {
  const { store, net } = storeElsewhere();
  const { server, twin } = await bothHoldBeside(store);
  writeFileSync(server.beside(RESULT), STRUCK);
  await until(async () => (await besideIn(store)) === STRUCK);

  net.drops = (call) => call === "transcripts.since";
  expect(await twin.hub()).toBe(true);
  net.drops = () => false;
  expect(readFileSync(twin.beside(RESULT), "utf-8")).toBe(OLD);
  expect(await besideIn(store)).toBe(STRUCK);

  expect(await twin.hub()).toBe(true);
  expect(readFileSync(twin.beside(RESULT), "utf-8")).toBe(STRUCK);
  expect(await besideIn(store)).toBe(STRUCK);
});

test("a machine that holds a conversation and what is beside it asks the store twice as it takes hex over, where the copy stands and what is beside it, and once more as the session starts", async () => {
  const { store, net } = storeElsewhere();
  const { twin } = await bothHoldBeside(store);
  net.asked.length = 0;
  const start = await twin.started();
  await until(() => net.asked.includes("besides"));
  await sent();
  expect(net.asked).toEqual(["prune", "end", "besides"]);

  net.asked.length = 0;
  expect(await start()).toBe(true);
  expect(net.asked).toEqual(["end"]);
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
  expect(twin.setAside()).toEqual([]);
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
  const image = Buffer.from(Array.from({ length: 1_300_000 }, (_byte, at) => (at * 7) % 256));
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
  await until(
    () => existsSync(twin.beside("toolu_01.txt")) && existsSync(twin.beside("shot-1.png")),
  );
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
  await until(() => existsSync(twin.beside("shot-1.png")));
  expect(existsSync(join(twin.transcripts, "escaped"))).toBe(false);
});

test("a tool result comes at a later start when the first didn't bring it, though the copy is this machine's own by then", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  mkdirSync(dirname(server.beside("toolu_01.txt")), { recursive: true });
  writeFileSync(server.beside("toolu_01.txt"), "what the tool said, in full\n");
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  await until(async () => (await store.transcripts.besides(SESSION)).length === 1);

  net.drops = (call) => call === "transcripts.besides";
  const start = await twin.started();
  expect(await start()).toBe(true);
  await until(() => net.dropped > 0);
  expect(existsSync(twin.beside("toolu_01.txt"))).toBe(false);
  appendFileSync(twin.path(), line("water them on Friday"));
  net.drops = () => false;
  await until(async () => (await store.transcripts.end(SESSION)).by === "twin");

  expect(await start()).toBe(true);
  await until(() => existsSync(twin.beside("toolu_01.txt")));
  expect(readFileSync(twin.beside("toolu_01.txt"), "utf-8")).toBe("what the tool said, in full\n");
});

test("a machine behind on a conversation asks the store once where its copy stands as it takes hex over, and takes what it lacks as the session starts", async () => {
  const { store, net } = storeElsewhere();
  const { server, twin } = await bothHold(store, line("x".repeat(300_000)));
  appendFileSync(server.path(), line("y".repeat(300_000)) + line("water them on Friday"));
  await until(async () => (await copyIn(store)) === server.written());

  net.asked.length = 0;
  const start = await twin.started();
  await until(() => net.asked.includes("end"));
  await sent();
  expect(net.asked).toEqual(["prune", "end"]);

  net.asked.length = 0;
  expect(await start()).toBe(true);
  expect(twin.written()).toBe(server.written());
  expect(net.asked).toEqual(["end", "since", "besides"]);
});

test("a tool result this machine wrote and then changed stays as it is here while the store can't be sent it", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  mkdirSync(dirname(server.beside(RESULT)), { recursive: true });
  writeFileSync(server.beside(RESULT), OLD);
  writeFileSync(server.path(), line("the plants are in the hall"));
  await server.hub();
  expect(await besideIn(store)).toBe(OLD);

  server.reaches(false);
  writeFileSync(server.beside(RESULT), STRUCK);
  net.drops = (call) => call === "transcripts.append";
  expect(await server.hub()).toBe(true);
  expect(net.dropped).toBeGreaterThan(0);
  expect(readFileSync(server.beside(RESULT), "utf-8")).toBe(STRUCK);
});

test("a thread goes on only from a conversation that is whole here: the one it forks, when it forks one, and else its own", async () => {
  const { store } = storeElsewhere();
  const forkedFrom = "7c1d2e3f-0a1b-4c2d-8e3f-9a0b1c2d3e4f";
  const twin = machine("twin", store, { fork: forkedFrom });

  await store.transcripts.append(forkedFrom, await store.transcripts.end(forkedFrom), [], {
    tail: "",
    of: 4096,
    last: "how the other machine's file ends",
    by: "server",
  });

  expect(await twin.hub(forkedFrom)).toBe(false);
  expect(await twin.hub()).toBe(true);
});

test("two starts that bring one copy at once beside an older file set that file aside once, as it was", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  const twin = machine("twin", store);
  writeFileSync(server.path(), line("the plants are in the hall") + line("water them on Friday"));
  await server.hub();
  await until(async () => (await copyIn(store)) === server.written());

  const older = line("the plants are in the hall") + line("said to the twin, long ago, at length");
  net.drops = (call) => call.startsWith("transcripts.");
  const start = await twin.started();
  writeFileSync(twin.path(), older);
  net.drops = () => false;
  net.takes = 5;
  expect(await Promise.all([start(), start()])).toEqual([true, true]);
  expect(twin.written()).toBe(server.written());
  expect(
    twin.setAside().map((aside) => readFileSync(join(twin.transcripts, aside), "utf-8")),
  ).toEqual([older]);
});

test("a session's start takes no turn behind the sends: its call leaves while a send's is still on its way", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  writeFileSync(server.path(), line("x".repeat(100_000)).repeat(40));
  net.takes = 20;
  const start = await server.started();
  await until(async () => (await store.transcripts.end(SESSION)).size > 0);
  net.mostOut = 0;

  const starting = start();
  await until(() => net.mostOut > 0);
  expect(net.mostOut).toBe(2);
  expect(await starting).toBe(true);
});

test("a file put back shorter than a copy of several pages gets the rest while its own hub's send is at the same copy", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  const whole = line("x".repeat(100_000)).repeat(70);
  writeFileSync(server.path(), whole);
  const start = await server.started();
  await until(async () => (await copyIn(store)) === whole);

  net.takes = 2;
  writeFileSync(server.path(), whole.slice(0, whole.indexOf("\n") + 1));
  expect(await start()).toBe(true);
  expect(server.written() === whole).toBe(true);
  expect((await copyIn(store)) === whole).toBe(true);
  expect(readdirSync(server.transcripts)).toEqual([`${SESSION}.jsonl`]);
});

test("a session that wrote on this machine under this hub is resumed there though the store says nothing of it, and one that didn't isn't", async () => {
  const { store, net } = storeElsewhere();
  const server = machine("server", store);
  net.drops = (call) => call.startsWith("transcripts.");
  writeFileSync(server.path(), line("the plants are in the hall"));
  const start = await server.started();
  expect(await start()).toBe(false);

  appendFileSync(server.path(), line("water them on Friday"));
  await until(start);
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
    { size: 0, tail: "", digest: "", of: 0, last: "", by: "" },
    [{ upto: 3, text: "{}\n", digest: "d1" }],
    { tail: "t1", digest: "d1", of: 3, last: "t1", by: "server" },
  ]);

  expect(grown.reply).toEqual({
    value: { size: 3, tail: "t1", digest: "d1", of: 3, last: "t1", by: "server" },
  });
  expect(grown.wrote).toBe(false);

  expect(call("threads", "keep", ["telegram", { [THREAD]: { name: "plants" } }]).wrote).toBe(true);
});
