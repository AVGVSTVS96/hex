import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DurableObject, Namespace } from "cloudflare:workers";

import { backup } from "../backup.ts";
import { File, file as fileIn, messagesSince, open, unclaimed } from "../store.ts";
import type { NewRow } from "../store.ts";
import { until } from "../until.ts";
import { back as backHome } from "./back.ts";
import { bring, layout, pages } from "./carry.ts";
import type { Read } from "./carry.ts";
import { OFFERS } from "./domains.ts";
import { objectStorage } from "./fake.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { move, MOVED } from "./move.ts";
import {
  LostError,
  MovedError,
  OtherStoreError,
  RefusedError,
  remote,
  UnaskedError,
  UnreachedError,
  unlease,
} from "./remote.ts";
import { resetting } from "./resetting.ts";
import { recordsIn } from "./storage.ts";
import type { Storage } from "./storage.ts";
import { answering, client } from "./wire.ts";
import type { Client } from "./wire.ts";

type State = ConstructorParameters<typeof DurableObject>[0];

type Env = { KEY?: string; VERSION?: string; STORE: Namespace };

const KEY = "a key long enough that nobody guesses it";

void mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: State;
    readonly env: Env;

    constructor(ctx: State, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The runtime's own pair of a ping and its answer, which the object only hands to its context.
Object.assign(globalThis, { WebSocketRequestResponsePair: Array });

const { default: worker, Records } = await import("./object.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "object-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const message = {
  key: "telegram:-100:42",
  to: "-100:7",
  from: "telegram",
  body: "Fix the login page. Also the logo looks blurry on retina.",
  author: "owner",
  meta: { user: "victor" },
} satisfies NewRow;

function startedEmpty(storage: Storage = objectStorage()) {
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");

  return recordsIn(storage, dir);
}

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

async function failure(pending: Promise<unknown>): Promise<string> {
  return await pending.then(() => "it didn't fail", String);
}

const sql = (text: string, ...bound: unknown[]) => JSON.stringify({ text, bound });

const raw = (domain: string, method: string, args: unknown[] = []) =>
  JSON.stringify({ domain, method, args });

function calling(object: ReturnType<typeof recordsIn>) {
  const wrote: boolean[] = [];

  const store = client((call) => {
    const called = object.call(call);
    wrote.push(called.wrote);

    return Promise.resolve(JSON.stringify(called.reply));
  });

  return { store, wrote: () => wrote.at(-1) };
}

test("an object with no records yet answers every call that it's empty, and writes nothing", async () => {
  const empty = recordsIn(objectStorage());
  const { store, wrote } = calling(empty);
  expect(empty.records()).toBeUndefined();
  expect(await failure(store.messages.deliver(message))).toContain(
    "hex's store is empty: hex store move brings a hex.db into it",
  );
  expect(wrote()).toBe(false);
  expect(empty.read(sql("select count(*) as n from _home"))).toEqual([{ n: 0 }]);
});

test("a call is answered as the records answer it, and says whether it wrote", async () => {
  const object = startedEmpty();
  const { store, wrote } = calling(object);
  expect(await store.messages.deliver(message)).toBe(true);
  expect(wrote()).toBe(true);
  expect(await store.messages.deliver(message)).toBe(false);
  expect(wrote()).toBe(false);
  expect(await store.messages.get(message.key)).toMatchObject({ body: message.body });
  expect(await store.messages.untaken()).toMatchObject([{ key: message.key }]);
  expect(await store.messages.untaken(undefined)).toMatchObject([{ key: message.key }]);
  expect(wrote()).toBe(false);
  await store.threads.keep("telegram", { "-100:7": { name: "General" } });
  expect(wrote()).toBe(true);
  expect(object.records()?.threads.list()).toMatchObject([{ thread: "-100:7", name: "General" }]);
  expect(await thrown(store.messages.deliver({ ...message, key: "42" }))).toBeInstanceOf(
    RefusedError,
  );
  expect(wrote()).toBe(false);
  expect(object.call(raw("messages", "constructor"))).toEqual({
    reply: {
      error: "the store has no messages.constructor: it is older than this hex",
      every: true,
    },
    wrote: false,
  });
  expect(object.call(raw("files", "list"))).toEqual({
    reply: { error: "the store has no files.list: it is older than this hex", every: true },
    wrote: false,
  });
  expect("error" in object.call("not json").reply).toBe(true);
});

test("a call that fails partway leaves the records as they were, and says it wrote nothing", async () => {
  const object = startedEmpty();
  const { store, wrote } = calling(object);
  await store.messages.deliver(message);
  expect(
    await failure(
      store.tasks.create({
        title: "Fix it",
        message: message.key,
        quote: "not in it",
        owner: "-100:7",
      }),
    ),
  ).toContain("as written");
  expect(object.records()?.tasks.list()).toEqual([]);
  expect(wrote()).toBe(false);
});

test("a read sees the records and refuses anything that writes", () => {
  const object = startedEmpty();
  object.call(raw("messages", "deliver", [message]));
  expect(object.read(sql('select key, "to" from messages where key = ?', message.key))).toEqual([
    { key: message.key, to: message.to },
  ]);

  for (const text of [
    "delete from messages returning key",
    "update _home set tenure = 9 returning tenure",
    "drop table messages",
    "insert into passes (n) values (1)",
    "pragma user_version = 0",
  ]) {
    expect(() => object.read(sql(text))).toThrow("hex sql");
  }

  expect(object.records()?.messages.get(message.key)).toMatchObject({ body: message.body });
  expect(() => object.read("not json")).toThrow();
});

const by = (claimant: string, lease?: number) =>
  JSON.stringify({ claimant, ...(lease !== undefined && { lease }) });

test("a hub that claims hex gets the next tenure, every hub that claimed before it is refused, and nothing it sends then is taken", () => {
  const object = startedEmpty();
  expect(object.lostTo(undefined)).toBeUndefined();
  expect(object.claim(by("a"))).toEqual({ tenure: 1 });
  expect(object.lostTo("1")).toBeUndefined();
  expect(object.claim(by("b"))).toEqual({ tenure: 2 });
  expect(object.lostTo("1")).toBe("tenure 1 no longer holds hex: tenure 2 does");
  expect(object.lostTo("2")).toBeUndefined();
  expect(object.lostTo(undefined)).toBeUndefined();
  expect(() => object.claim("{}")).toThrow();
});

test("a claim that arrives again gets its tenure while it holds hex, and one the network held back past a later claim takes nothing from it", () => {
  const object = startedEmpty();
  expect(object.claim(by("a"))).toEqual({ tenure: 1 });
  expect(object.claim(by("a"))).toEqual({ tenure: 1 });
  expect(object.lostTo("1")).toBeUndefined();
  expect(object.claim(by("b"))).toEqual({ tenure: 2 });
  expect(object.claim(by("a"))).toEqual({ lost: "tenure 1 no longer holds hex: tenure 2 does" });
  expect(object.lostTo("2")).toBeUndefined();
});

test("a lease tool's number never goes back: a hub on the same lease claims again, one on a lower lease or none is refused, until the owner ends the lease", () => {
  const object = startedEmpty();
  expect(object.claim(by("a", 6))).toEqual({ tenure: 1 });
  expect(object.claim(by("b", 6))).toEqual({ tenure: 2 });
  expect(object.claim(by("c", 5))).toEqual({
    lost: "lease 5 no longer holds hex: lease 6 does",
  });
  expect(object.lostTo("2")).toBeUndefined();
  expect(object.claim(by("d", 7))).toEqual({ tenure: 3 });
  expect(object.lostTo("2")).toBe("tenure 2 no longer holds hex: tenure 3 does");
  expect(object.claim(by("plain"))).toEqual({
    lost: "hex runs under lease 7: start it with HEX_STORE_LEASE, or end the lease with hex store lease clear",
  });
  expect(object.lostTo("3")).toBeUndefined();
  object.unlease();
  expect(object.claim(by("plain"))).toEqual({ tenure: 4 });
  expect(object.claim(by("e", 1))).toEqual({ tenure: 5 });
  expect(object.claim(by("again"))).toEqual({
    lost: "hex runs under lease 1: start it with HEX_STORE_LEASE, or end the lease with hex store lease clear",
  });
  expect(() => object.claim(by("f", -1))).toThrow();
  expect(() => object.claim('{"claimant": "g", "lease": 1e999}')).toThrow();
});

test("a tenure that isn't one the object gave out is refused and never kept, so it can't wedge the object", () => {
  const object = startedEmpty();
  object.claim(by("a"));

  for (const insane of ["1e999", "Infinity", "-1", "2", "abc", "", "9".repeat(30), " 1"]) {
    expect(object.lostTo(insane)).toContain("isn't one hex's store gave out");
  }

  expect(object.lostTo("1")).toBeUndefined();
  expect(object.call(raw("messages", "untaken"))).toMatchObject({ reply: { value: [] } });
  expect(object.migrations()).toBe(appendOnlyMigrations.length);
});

test("an object made before it kept whether a hub had used it learns to, and counts as unused until a call", () => {
  const storage = objectStorage();
  storage.sql.exec(
    "create table _home (one integer primary key check (one = 1), version integer not null, tenure integer not null default 0)",
  );
  storage.sql.exec("insert into _home (one, version) values (1, 0)");
  const object = recordsIn(storage, dir);
  expect(object.moved("state", "{}")).toEqual({
    arrived: true,
    served: false,
    version: appendOnlyMigrations.length,
    moving: null,
  });
  object.call(raw("messages", "untaken"));
  expect(object.moved("state", "{}")).toMatchObject({ served: true });
  expect(() => object.moved("begin", "{}")).toThrow("has served a hub");
});

test("a tenure the object gave out holds through its restarts", () => {
  const storage = objectStorage();
  const object = startedEmpty(storage);
  object.claim(by("a"));
  object.claim(by("b"));
  expect(recordsIn(storage, dir).lostTo("1")).toBe("tenure 1 no longer holds hex: tenure 2 does");
});

type Between = (
  route: string,
  answer: () => Promise<Response>,
  request: Request,
) => Promise<Response>;

function served(storage = objectStorage(), env?: Omit<Env, "STORE">, between?: Between) {
  const objects = new Map<string, InstanceType<typeof Records>>();
  const storages = new Map<string, Storage>([["hex", storage]]);

  const named: Env = {
    ...(env ?? { KEY }),
    STORE: {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => ({
        fetch: async (request) => {
          const name = id.toString();

          const records =
            objects.get(name) ??
            new Records(
              {
                storage:
                  storages.get(name) ?? storages.set(name, objectStorage()).get(name) ?? storage,
                acceptWebSocket: () => {},
                getWebSockets: () => [],
                setWebSocketAutoResponse: () => {},
              },
              named,
            );

          objects.set(name, records);
          const route = new URL(request.url).pathname.split("/").slice(2).join("/");
          const answer = async () => await records.fetch(request);

          return between === undefined ? await answer() : await between(route, answer, request);
        },
      }),
    },
  };

  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, named) });

  return {
    storage,
    storageOf: (name: string) => storages.get(name),
    url: server.url.origin,
    stop: async () => {
      await server.stop(true);
    },
  };
}

const heard: string[] = [];

function hear(line: string) {
  heard.push(line);
}

function filled(at: string) {
  const file = new File(at);
  file.messages.deliver(message);
  file.messages.deliver({ ...message, key: "telegram:-100:43", body: "and the docs" });
  file.messages.take(message.key, "s-1");
  file.turns.turned("s-1", true, "2026-11-17T10:00:00.000Z");
  file.threads.keep("telegram", { "-100:7": { name: "General", session: "s-1" } });

  const task = file.tasks.create({
    title: "Fix the login",
    message: message.key,
    quote: "Fix the login page.",
    owner: "-100:7",
  });

  file.tasks.addWords(task.id, "telegram:-100:43");
  file.tasks.create({ title: "Sharpen the logo", message: message.key, owner: "-100:7" });
  file.questions.ask({
    app: "telegram",
    thread: "-100:7",
    message: 50,
    text: "Ship it?",
    options: ["Yes", "No"],
  });
  file.questions.answered("telegram", "-100:7", 50, "Yes", "telegram");
  file.profiles.profiled("", "# Who he is\n- Ships on fridays");
  file.seen.show("s-1", "tasks", "t-1");

  for (let n = 0; n < 1200; n++) {
    file.messages.deliver({ ...message, key: `telegram:-100:${1000 + n}`, body: `line ${n}` });
  }

  return file;
}

async function answers(store: Client) {
  return {
    since: await store.messages.since(),
    untaken: await store.messages.untaken(),
    tasks: await store.tasks.list(),
    threads: await store.threads.list(),
    question: await store.questions.get("telegram", "-100:7", 50),
    profiles: await store.profiles.list(),
    seen: await store.seen.get("s-1", "tasks"),
    turn: await store.turns.get("s-1"),
  };
}

test("a hex.db moves into an empty object whole, the folder's store is then the object, and a copy brought back is a hex.db a hex runs on", async () => {
  const file = filled(dir);
  const before = await answers(file.store);
  file.db.close();
  const object = served();
  const said: string[] = [];

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, (line) => {
      said.push(line);
    });
    expect(said.at(-1)).toContain(`hex.db is kept as ${MOVED}`);
    expect(existsSync(join(dir, "hex.db"))).toBe(false);
    expect(existsSync(join(dir, MOVED))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"))).toEqual({
      url: object.url,
      name: "hex",
      key: KEY,
    });

    const there = recordsIn(object.storage, dir);
    expect(there.read(sql("select version from _home"))).toEqual([
      { version: appendOnlyMigrations.length },
    ]);
    expect(await answers(calling(there).store)).toEqual(before);

    const store = open(dir);
    expect(await answers(store)).toEqual(before);
    expect(await store.read("select count(*) as n from messages")).toEqual([{ n: 1202 }]);

    mkdirSync(join(dir, "back"));
    await store.copy(join(dir, "back", "hex.db"));
    expect(existsSync(join(dir, "back", "hex.db.part"))).toBe(false);
    const back = new File(join(dir, "back"));
    expect(back.db.query("pragma user_version").get()).toEqual({
      user_version: appendOnlyMigrations.length,
    });
    expect(await answers(back.store)).toEqual(before);
    expect(() => {
      back.db.run("delete from words");
    }).toThrow("never taken away");
    expect(back.tasks.create({ title: "Again", message: message.key, owner: "-100:7" }).id).toBe(
      "t-3",
    );
    expect(back.db.query("pragma foreign_key_check").all()).toEqual([]);
  } finally {
    await object.stop();
  }
});

test("a move refuses a hex.db this hex hasn't migrated, a folder whose records moved already, an address that isn't https, and an object a hub has used", async () => {
  const object = served();
  const to = { url: object.url, name: "hex", key: KEY };

  try {
    const file = new File(dir);
    file.db.run("pragma user_version = 3");
    file.db.close();
    expect(await failure(move(dir, to, hear))).toContain(
      `hex.db is at migration 3 and this hex at ${appendOnlyMigrations.length}`,
    );
    expect(existsSync(join(dir, "store.json"))).toBe(false);
    expect(
      await failure(move(dir, { ...to, url: "http://store.example.workers.dev" }, hear)),
    ).toContain("a store's address is https");
    expect(await failure(move(dir, { ...to, key: "short" }, hear))).toContain("key");

    const other = join(dir, "other");
    filled(other).db.close();
    await move(other, to, hear);
    expect(await failure(move(other, to, hear))).toContain("this folder's records have moved");

    const third = join(dir, "third");
    filled(third).db.close();
    await open(other).messages.untaken();
    expect(await failure(move(third, to, hear))).toContain("has served a hub");
    expect(existsSync(join(third, "hex.db"))).toBe(true);
    expect(existsSync(join(third, "store.json"))).toBe(false);
    expect(await open(other).messages.get(message.key)).toMatchObject({ body: message.body });

    await move(third, { ...to, name: "restored" }, hear);
    expect(await open(third).messages.get(message.key)).toMatchObject({ body: message.body });
  } finally {
    await object.stop();
  }
});

const givesUp = { answerWithin: 10_000, firstRetry: 10, longestRetry: 10, giveUpAfter: 0 };

test("a move whose last reply was lost is finished by running it again, and one that differs starts over, until a hub has used the object", async () => {
  let losing: "arrived" | "arrived, then state" | "state" | undefined;

  const object = served(objectStorage(), { KEY }, async (route, answer) => {
    const answered = await answer();

    const lost =
      (route === "move/arrived" && losing?.startsWith("arrived") === true) ||
      (route === "move/state" && losing === "state");

    if (!lost) {
      return answered;
    }

    losing = losing === "arrived, then state" ? "state" : undefined;

    return new Response("<html>bad gateway</html>", { status: 502 });
  });

  const to = { url: object.url, name: "hex", key: KEY };

  try {
    filled(dir).db.close();
    losing = "arrived";
    const said: string[] = [];
    await move(dir, to, (line) => {
      said.push(line);
    });
    expect(existsSync(join(dir, "store.json"))).toBe(true);

    const again = join(dir, "again");
    filled(again).db.close();
    losing = "arrived, then state";
    expect(await failure(move(again, { ...to, name: "again" }, hear, givesUp))).toContain(
      "answered 502",
    );
    expect(existsSync(join(again, "store.json"))).toBe(false);
    expect(existsSync(join(again, "hex.db"))).toBe(true);

    const finished: string[] = [];
    await move(again, { ...to, name: "again" }, (line) => {
      finished.push(line);
    });
    expect(finished).toContain(
      "the object again has every row from a move whose last reply was lost",
    );
    expect(finished.some((line) => line.endsWith("rows sent"))).toBe(false);
    expect(await open(again).messages.get(message.key)).toMatchObject({ body: message.body });

    const changed = join(dir, "changed");
    filled(changed).db.close();
    losing = "arrived, then state";
    expect(await failure(move(changed, { ...to, name: "changed" }, hear, givesUp))).toContain(
      "answered 502",
    );
    const file = new File(changed);
    file.messages.deliver({ ...message, key: "telegram:-100:44", body: "one more" });
    file.db.close();
    const restarted: string[] = [];
    await move(changed, { ...to, name: "changed" }, (line) => {
      restarted.push(line);
    });
    expect(restarted.some((line) => line.includes("it starts over"))).toBe(true);
    expect(await open(changed).messages.get("telegram:-100:44")).toMatchObject({
      body: "one more",
    });
  } finally {
    await object.stop();
  }
});

test("the object answers only its owner's key, never without one, and refuses a hub that lost hex before reading what it sent", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage, { KEY, VERSION: "v7" });

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, object.url), {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, ...headers },
      body,
    });

  try {
    expect((await post("/hex/call", "{}", { authorization: "Bearer another" })).status).toBe(401);
    expect((await post("/hex/call", "{}", { authorization: `Bearer ${KEY}x` })).status).toBe(401);
    expect((await post("/call", "{}")).status).toBe(404);
    expect(await (await post("/hex/call", raw("messages", "untaken"))).json()).toEqual({
      value: [],
    });
    expect(
      await (
        await fetch(new URL("/hex/version", object.url), {
          headers: { authorization: `Bearer ${KEY}` },
        })
      ).json(),
    ).toEqual({ version: "v7", migrations: appendOnlyMigrations.length, offers: OFFERS });
    expect(await (await post("/hex/claim", by("a"))).json()).toEqual({ value: 1 });
    expect(await (await post("/hex/claim", by("b"))).json()).toEqual({ value: 2 });
    expect((await post("/hex/call", "{}", { "hex-tenure": "2" })).status).toBe(200);

    const refused = await post("/hex/call", raw("messages", "deliver", [message]), {
      "hex-tenure": "1",
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "tenure 1 no longer holds hex: tenure 2 does",
      lost: true,
    });
    expect((await post("/hex/call", "{}", { "hex-tenure": "1e999" })).status).toBe(409);
    expect((await post("/hex/version", "")).status).toBe(200);
    expect(recordsIn(object.storage, dir).records()?.messages.untaken()).toEqual([]);
  } finally {
    await object.stop();
  }

  for (const env of [{}, { KEY: "too short" }]) {
    const keyless = served(storage, env);

    try {
      for (const authorization of ["Bearer undefined", "Bearer too short", "Bearer "]) {
        const answer = await fetch(new URL("/hex/sql", keyless.url), {
          method: "POST",
          headers: { authorization },
          body: sql("select 1"),
        });

        expect(answer.status).toBe(503);
        expect(await answer.text()).toContain("has no key yet");
      }
    } finally {
      await keyless.stop();
    }
  }
});

const quick = { answerWithin: 200, firstRetry: 100, longestRetry: 100, heartbeat: 100 };

function pointedAt(at: string, url: string, name = "hex") {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "store.json"), JSON.stringify({ url, name, key: KEY }));
}

test("a store that can't reach the object fails fast until a probe gets an answer, and synced rejects meanwhile", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  let mode: "answer" | "hang" | "html" = "hang";
  let reached = 0;

  const front = Bun.serve({
    port: 0,
    fetch: async (request) => {
      reached += 1;

      if (mode === "hang") {
        return await new Promise<Response>(() => {});
      }

      if (mode === "html") {
        return new Response("<html>the origin is unreachable</html>", { status: 523 });
      }

      const { pathname } = new URL(request.url);

      if (pathname.endsWith("/watch")) {
        return new Response("no sockets here", { status: 404 });
      }

      return await fetch(new URL(pathname, object.url), {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
    },
  });

  pointedAt(dir, front.url.origin);
  const store = remote(dir, quick);

  try {
    if (store === undefined) {
      throw new Error("no store.json");
    }

    const started = performance.now();
    const first = await thrown(store.messages.deliver(message));
    expect(first).toBeInstanceOf(UnreachedError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(quick.answerWithin - 20);
    const sent = reached;

    const quickly = performance.now();
    const behind = await Promise.allSettled([store.messages.untaken(), store.threads.list()]);
    expect(
      behind.map((each) => each.status === "rejected" && each.reason instanceof UnreachedError),
    ).toEqual([true, true]);
    expect(performance.now() - quickly).toBeLessThan(50);
    expect(await thrown(store.synced())).toBeInstanceOf(UnreachedError);
    expect(await thrown(store.read("select 1 as n"))).toBeInstanceOf(UnreachedError);
    expect(reached).toBe(sent);

    mode = "html";
    await until(() => reached > sent);
    expect(await thrown(store.messages.untaken())).toBeInstanceOf(UnreachedError);

    let rang = 0;

    const stop = store.watch(() => {
      rang += 1;
    });

    mode = "answer";
    await until(() => rang > 0);
    stop();
    expect(await store.messages.deliver(message)).toBe(true);
    await store.synced();
    expect(await thrown(store.messages.deliver({ ...message, key: "42" }))).toBeInstanceOf(
      RefusedError,
    );
    await store.synced();
  } finally {
    await front.stop(true);
    await object.stop();
  }
});

test("a hub another hub claimed hex from is lost for good: every call after it and synced say so at once, and nothing it sends lands", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  pointedAt(dir, object.url);
  process.env.HEX_STORE_LEASE = "4";
  const first = remote(dir, quick);
  expect(process.env.HEX_STORE_LEASE).toBeUndefined();
  process.env.HEX_STORE_LEASE = "4";
  const second = remote(dir, quick);
  process.env.HEX_STORE_LEASE = "3";
  const stale = remote(dir, quick);
  const hook = remote(dir, quick);

  try {
    if (first === undefined || second === undefined || stale === undefined || hook === undefined) {
      throw new Error("no store.json");
    }

    await first.claim();
    expect(await first.messages.deliver(message)).toBe(true);
    await second.claim();

    const refused = await thrown(first.messages.deliver({ ...message, key: "telegram:-100:43" }));
    expect(refused).toBeInstanceOf(LostError);
    expect(String(refused)).toContain("tenure 1 no longer holds hex: tenure 2 does");
    expect(await thrown(first.clock.now())).toBeInstanceOf(LostError);
    expect(await thrown(first.synced())).toBeInstanceOf(LostError);
    expect(await second.messages.get("telegram:-100:43")).toBeNull();
    expect(await second.messages.get(message.key)).toMatchObject({ body: message.body });

    expect(await thrown(stale.claim())).toBeInstanceOf(LostError);
    expect(await thrown(stale.messages.untaken())).toBeInstanceOf(LostError);
    expect(await hook.messages.deliver({ ...message, key: "telegram:-100:44" })).toBe(true);
    await second.synced();
  } finally {
    await object.stop();
  }
});

test("a store.json whose address isn't https, or whose key is short, is refused before anything is sent", () => {
  const refused = (url: string, key: string) => {
    writeFileSync(join(dir, "store.json"), JSON.stringify({ url, name: "hex", key }));

    return () => remote(dir);
  };

  expect(refused("http://store.example.workers.dev", KEY)).toThrow("https");
  expect(refused("https://store.example.workers.dev", "short")).toThrow("key");

  pointedAt(dir, "http://127.0.0.1:9");
  expect(remote(dir)).toBeDefined();
});

test("a watch socket that goes quiet is dropped and opened again, and one that answers its heartbeat is kept", async () => {
  let opened = 0;
  let pinging = false;

  const server = Bun.serve({
    port: 0,
    fetch: (request, at) => (at.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: () => {
        opened += 1;
      },
      message: (socket, data) => {
        if (pinging && data === "ping") {
          socket.send("pong");
        }
      },
    },
  });

  pointedAt(dir, server.url.origin);
  const store = remote(dir, quick);
  let rang = 0;

  try {
    if (store === undefined) {
      throw new Error("no store.json");
    }

    const stop = store.watch(() => {
      rang += 1;
    });

    await until(() => opened >= 2 && rang >= 2);

    pinging = true;
    await Bun.sleep(400);
    const steady = opened;
    const rings = rang;
    await Bun.sleep(1000);
    expect(opened).toBe(steady);
    expect(rang).toBe(rings);
    stop();
  } finally {
    await server.stop(true);
  }
});

test("hex sql can change nothing on either home: one statement, and no pragma that sets anything", async () => {
  const storage = objectStorage();
  const object = startedEmpty(storage);
  const file = new File(join(dir, "file"));

  const refused = [
    "pragma foreign_keys = off",
    "pragma foreign_keys(0)",
    "pragma main.ignore_check_constraints = 1",
    "pragma journal_mode = delete",
    "pragma optimize",
    "select 1; pragma foreign_keys = off",
    "select 1 as a; select 2 as b",
    "attach database 'other.db' as other",
    "vacuum",
    "explain pragma ignore_check_constraints = on",
    "explain query plan pragma recursive_triggers = 1",
    ";pragma case_sensitive_like = 1",
    "; ; pragma foreign_keys = off",
    "/* a note */ pragma foreign_keys = off",
    "delete from messages",
    "insert into passes (n) values (1)",
    "with gone as (select 1) delete from messages",
    "analyze",
    "reindex",
    "create table extra (a)",
  ];

  for (const text of refused) {
    expect(() => object.read(sql(text))).toThrow("hex sql");
  }

  expect(object.read(sql("select ';' as semicolon -- ; pragma foreign_keys = off"))).toEqual([
    { semicolon: ";" },
  ]);
  expect(object.read(sql("pragma table_info('_home')")).length).toBeGreaterThan(0);
  expect(object.read(sql("explain query plan select * from messages")).length).toBeGreaterThan(0);
  expect(object.read(sql("pragma foreign_keys"))).toEqual([{ foreign_keys: 1 }]);
  expect(storage.sql.exec("pragma foreign_keys").toArray()).toEqual([{ foreign_keys: 1 }]);

  for (const text of refused) {
    expect(await failure(file.store.read(text))).toContain("hex sql");
  }

  expect(file.db.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(await file.store.read("pragma table_info('messages')")).not.toEqual([]);
});

test("the stand-in refuses what the runtime refuses: more than 100 variables, statements over 100 KB, values over 8 MiB, and it binds numbers as doubles", () => {
  const { sql: run } = objectStorage();

  expect(() =>
    run.exec(
      `select ${Array.from({ length: 101 }, () => "?").join(", ")}`,
      ...Array.from({ length: 101 }, () => 1),
    ),
  ).toThrow("too many SQL variables");
  expect(
    run
      .exec(
        `select ${Array.from({ length: 100 }, () => "?").join(", ")} as last`,
        ...Array.from({ length: 100 }, () => 1),
      )
      .toArray(),
  ).toHaveLength(1);
  expect(() => run.exec(`select 1 /*${"a".repeat(100_000)}*/`)).toThrow("statement too long");
  expect(() => run.exec("select length(?) as n", "a".repeat(8 * 1024 * 1024 + 1))).toThrow(
    "too big",
  );
  expect(run.exec("select length(?) as n", "a".repeat(8 * 1024 * 1024)).toArray()).toEqual([
    { n: 8 * 1024 * 1024 },
  ]);
  expect(
    run.exec("select typeof(?) as number, ?2 as same, typeof(?) as word", 5, 7, true).toArray(),
  ).toEqual([{ number: "real", same: 7, word: "text" }]);
  expect(run.exec("select 1 as a; select 2 as b").toArray()).toEqual([{ b: 2 }]);
  expect(() => run.exec("create table t (a); insert into t values (?)", 1)).toThrow(
    "only the last statement can have parameters",
  );
});

test("a copy reads each table before the tables it references, so rows written while it reads never name a row it missed, and a copy that fails leaves no file", async () => {
  const storage = objectStorage();
  const object = startedEmpty(storage);
  const records = object.records();

  if (records === undefined) {
    throw new Error("no records");
  }

  records.messages.deliver(message);
  const { tables } = await layout(async (text) => await Promise.resolve(object.read(sql(text))));
  const order = tables.map(({ name }) => name);

  for (const [referencing, referenced] of [
    ["words", "messages"],
    ["words", "tasks"],
    ["task_agents", "tasks"],
    ["held", "holds"],
  ] as const) {
    expect(order.indexOf(referencing)).toBeLessThan(order.indexOf(referenced));
  }

  let n = 0;

  const writing: Read = async (text) => {
    const rows = object.read(sql(text));

    if (/^select .* from "\w+" where rowid > 0 /u.test(text)) {
      n += 1;
      const key = `telegram:-100:${2000 + n}`;
      records.messages.deliver({ ...message, key, body: `asked mid-copy ${n}` });
      records.tasks.create({ title: `task ${n}`, message: key, owner: "-100:7" });
    }

    return await Promise.resolve(rows);
  };

  const to = join(dir, "copy.db");
  await bring(writing, to);
  const copy = new File(join(dir, "copy-dir"));
  copy.db.close();
  const db = new Database(to, { readonly: true });
  expect(db.query("pragma foreign_key_check").all()).toEqual([]);
  db.close();

  const failing: Read = async (text) => {
    if (text.includes('from "messages"')) {
      throw new Error("the line dropped");
    }

    return await Promise.resolve(object.read(sql(text)));
  };

  const lost = join(dir, "lost.db");
  expect(await failure(bring(failing, lost))).toContain("the line dropped");
  expect(existsSync(lost)).toBe(false);
  expect(existsSync(`${lost}.part`)).toBe(false);
});

test("every message is read a page to a reply", async () => {
  const file = filled(dir);
  const read = await Array.fromAsync(messagesSince(file.store));
  expect(read.map((page) => page.length)).toEqual([500, 500, 202]);
  expect(read.flat()).toEqual(file.messages.since());
  const later = read[1]?.[0]?.at ?? "";
  expect((await Array.fromAsync(messagesSince(file.store, later))).flat()).toEqual(
    file.messages.since(later),
  );
});

test("the store says which no it gave: one to every call is unreached, one to this call is refused, on either home", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);

  try {
    pointedAt(dir, object.url);
    const store = remote(dir, quick);
    const wrongKey = join(dir, "wrong-key");
    mkdirSync(wrongKey);
    writeFileSync(
      join(wrongKey, "store.json"),
      JSON.stringify({ url: object.url, name: "hex", key: `${KEY} but not it` }),
    );
    const empty = join(dir, "empty");
    pointedAt(empty, object.url, "nobody");

    if (store === undefined) {
      throw new Error("no store.json");
    }

    expect(await thrown(store.messages.deliver({ ...message, key: "42" }))).toBeInstanceOf(
      RefusedError,
    );
    await store.synced();
    expect(await thrown(remote(wrongKey, quick)?.messages.untaken() ?? never)).toBeInstanceOf(
      UnreachedError,
    );
    expect(await thrown(remote(empty, quick)?.messages.untaken() ?? never)).toBeInstanceOf(
      UnreachedError,
    );
  } finally {
    await object.stop();
  }

  const file = new File(join(dir, "file"));
  expect(await thrown(file.store.messages.deliver({ ...message, key: "42" }))).toBeInstanceOf(
    RefusedError,
  );

  const records = startedEmpty().records();

  if (records === undefined) {
    throw new Error("no records");
  }

  Object.defineProperty(records.messages, "untaken", {
    value: () => {
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    },
  });

  const broken = client((call) => Promise.resolve(JSON.stringify(answering(records)(call))));
  expect(await thrown(broken.messages.untaken())).toBeInstanceOf(UnreachedError);
});

test("a file home whose records moved since it opened says so on every call, so a hub that opened it before the move doesn't keep records nobody reads", async () => {
  const hub = filled(dir);
  const object = served();

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear);
    expect(
      await thrown(hub.store.messages.deliver({ ...message, key: "telegram:-100:9" })),
    ).toBeInstanceOf(MovedError);
    expect(await thrown(hub.store.messages.untaken())).toBeInstanceOf(MovedError);
    expect(await thrown(hub.store.read("select 1 as n"))).toBeInstanceOf(MovedError);
    expect(await open(dir).messages.get(message.key)).toMatchObject({ body: message.body });
  } finally {
    await object.stop();
  }
});

test("one call whose connection resets fails alone: the store answers a probe, so no call behind it, in this process or another, is failed unasked", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  const front = await resetting(object.url);
  pointedAt(dir, front.url);

  try {
    const hub = remote(dir, quick);
    await hub?.claim();
    expect(await hub?.messages.deliver(message)).toBe(true);

    front.arm();

    const reset = await thrown(
      hub?.messages.deliver({ ...message, key: "telegram:-100:43" }) ?? never,
    );

    expect(reset).toBeInstanceOf(UnreachedError);
    expect(reset).not.toBeInstanceOf(UnaskedError);
    expect(front.resets()).toBe(1);
    expect(existsSync(join(dir, "store.down"))).toBe(false);

    expect(await hub?.messages.deliver({ ...message, key: "telegram:-100:43" })).toBe(true);
    await hub?.synced();
    expect(await remote(dir, quick)?.messages.get("telegram:-100:43")).toMatchObject({
      body: message.body,
    });
  } finally {
    await front.stop();
    await object.stop();
  }
});

test("a process that finds the object not answering tells the next, which fails at once as unasked instead of waiting out its own time, and a client that keeps to itself asks", async () => {
  let reached = 0;
  let hang = true;

  const front = Bun.serve({
    port: 0,
    fetch: async () => {
      reached += 1;

      if (hang) {
        return await new Promise<Response>(() => {});
      }

      return Response.json({ value: "2026-11-17T10:00:00.000Z" });
    },
  });

  pointedAt(dir, front.url.origin);

  try {
    const first = remote(dir, quick);
    const asked = await thrown(first?.clock.now() ?? never);
    expect(asked).toBeInstanceOf(UnreachedError);
    expect(asked).not.toBeInstanceOf(UnaskedError);
    expect(existsSync(join(dir, "store.down"))).toBe(true);

    const hook = remote(dir, quick);
    const started = performance.now();
    const sent = reached;
    expect(await thrown(hook?.clock.now() ?? never)).toBeInstanceOf(UnaskedError);
    expect(await thrown(first?.clock.now() ?? never)).toBeInstanceOf(UnaskedError);
    expect(performance.now() - started).toBeLessThan(50);
    expect(reached).toBe(sent);

    const fresh = await thrown(remote(dir, quick, false)?.clock.now() ?? never);
    expect(fresh).toBeInstanceOf(UnreachedError);
    expect(fresh).not.toBeInstanceOf(UnaskedError);
    expect(String(fresh)).toContain("didn't answer");

    hang = false;
    await until(() => !existsSync(join(dir, "store.down")));
    expect(await remote(dir, quick)?.clock.now()).toBe("2026-11-17T10:00:00.000Z");

    hang = true;
    writeFileSync(join(dir, "store.down"), "long ago\n");
    utimesSync(join(dir, "store.down"), new Date(0), new Date(0));
    hang = false;
    expect(await remote(dir, quick)?.clock.now()).toBe("2026-11-17T10:00:00.000Z");
  } finally {
    await front.stop(true);
  }
});

test("a move sees a value whose type differs in the object, which JSON alone reads alike", async () => {
  let losing: "arrived" | "state" | undefined;

  const object = served(objectStorage(), undefined, async (route, answer) => {
    const answered = await answer();

    if (route === `move/${losing}`) {
      losing = losing === "arrived" ? "state" : undefined;

      return new Response("<html>bad gateway</html>", { status: 502 });
    }

    return answered;
  });

  const to = { url: object.url, name: "typed", key: KEY };

  try {
    const file = new File(dir);
    file.messages.deliver(message);
    file.questions.ask({
      app: "telegram",
      thread: "-100:7",
      message: 50,
      text: "Ship?",
      options: ["Yes"],
    });
    file.db.close();
    losing = "arrived";
    expect(await failure(move(dir, to, hear, givesUp))).toContain("answered 502");

    const there = await fetch(new URL("/typed/sql", object.url), {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: sql("select typeof(message) as type from questions"),
    });

    expect(await there.json()).toEqual({ value: [{ type: "integer" }] });
    object.storageOf("typed")?.sql.exec("update questions set message = cast(message as real)");
    const said: string[] = [];
    await move(dir, to, (line) => {
      said.push(line);
    });
    expect(said.some((line) => line.includes("questions holds values of other types"))).toBe(true);
    expect(said.some((line) => line.includes("it starts over"))).toBe(true);
    expect(await open(dir).read("select typeof(message) as type from questions")).toEqual([
      { type: "integer" },
    ]);
  } finally {
    await object.stop();
  }
});

test("a 409 that isn't the object's word, like Cloudflare's edge sends for its own errors, is an outage, not another hub", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  let edge = true;

  const front = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (edge) {
        return new Response("<html>error code: 1018</html>", { status: 409 });
      }

      return await fetch(new URL(new URL(request.url).pathname, object.url), {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
    },
  });

  pointedAt(dir, front.url.origin);

  try {
    const store = remote(dir, quick);
    expect(await thrown(store?.claim() ?? never)).toBeInstanceOf(UnreachedError);
    expect(await thrown(store?.messages.untaken() ?? never)).toBeInstanceOf(UnreachedError);
    edge = false;
    await until(async () => (await thrown(store?.claim() ?? never)) === "it didn't throw");
    expect(await store?.messages.deliver(message)).toBe(true);
    await store?.synced();
  } finally {
    await front.stop(true);
    await object.stop();
  }
});

test("a page Cloudflare's edge answers in place of the Worker, as it does for minutes after a deploy, is asked again and never counts as the store not answering", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  let calls = 0;
  let stray = 0;

  const front = Bun.serve({
    port: 0,
    fetch: async (request) => {
      calls += 1;

      if (calls % 2 === 1) {
        stray += 1;

        return new Response("<!DOCTYPE html><html>There is nothing here yet</html>", {
          status: 404,
        });
      }

      return await fetch(new URL(new URL(request.url).pathname, object.url), {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
    },
  });

  pointedAt(dir, front.url.origin);

  try {
    const store = remote(dir, quick);
    await store?.claim();
    expect(await store?.messages.deliver(message)).toBe(true);
    expect((await store?.messages.untaken())?.length).toBe(1);
    await store?.synced();
    expect(stray).toBeGreaterThan(2);
    expect(existsSync(join(dir, "store.down"))).toBe(false);
  } finally {
    await front.stop(true);
    await object.stop();
  }
});

test("a first claim the network holds back until after its retry never makes a lone hub refuse itself", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  const held: (() => void)[] = [];
  let holding = true;
  let heldLanded = false;

  const front = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.text();

      const pass = async () =>
        await fetch(new URL(new URL(request.url).pathname, object.url), {
          method: request.method,
          headers: request.headers,
          body,
        });

      if (holding && new URL(request.url).pathname.endsWith("/claim")) {
        holding = false;
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });

        const answer = await pass();
        heldLanded = true;

        return answer;
      }

      return await pass();
    },
  });

  pointedAt(dir, front.url.origin);

  try {
    const hub = remote(dir, quick);
    expect(await thrown(hub?.claim() ?? never)).toBeInstanceOf(UnreachedError);
    await until(async () => (await thrown(hub?.claim() ?? never)) === "it didn't throw");
    expect(await hub?.messages.deliver(message)).toBe(true);

    for (const release of held) {
      release();
    }

    await until(() => heldLanded);
    expect(
      await hub?.messages.deliver({ ...message, key: "telegram:-100:43", body: "after" }),
    ).toBe(true);
    await hub?.synced();
  } finally {
    await front.stop(true);
    await object.stop();
  }
});

test("hex sql reads a query that only names a word like replace or update, and refuses a with that writes", async () => {
  const object = startedEmpty();
  const file = new File(join(dir, "file"));

  for (const text of [
    "select replace('abc', 'a', 'b') as r",
    "select 1 as update_count",
    "with x as (select replace('a', 'a', 'b') as r) select r from x",
  ]) {
    expect(object.read(sql(text)).length).toBe(1);
    expect(await file.store.read(text)).toHaveLength(1);
  }

  for (const text of [
    "with x as (select 1) delete from messages",
    "with x as (select 1), y as (select 2) insert into passes (n) select 1 from x",
  ]) {
    expect(() => object.read(sql(text))).toThrow("hex sql");
    expect(await failure(file.store.read(text))).toContain("hex sql");
  }
});

const edge = () =>
  new Response("<html><h1>404 Not Found</h1>cloudflare</html>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });

test("a move rides out pages that aren't the object's own, and never sends again a step that may have landed", async () => {
  const forwarded = new Map<string, number>();
  let steps = 0;

  const object = served(objectStorage(), undefined, async (route, answer, request) => {
    if (!route.startsWith("move/") || route === "move/state") {
      return await answer();
    }

    steps += 1;

    if (steps % 5 === 1) {
      return edge();
    }

    const mark = request.headers.get("hex-move") ?? "";
    forwarded.set(mark, (forwarded.get(mark) ?? 0) + 1);
    const answered = await answer();

    return steps % 5 === 3 ? edge() : answered;
  });

  try {
    const file = filled(dir);
    const before = await answers(file.store);
    file.db.close();
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear, {
      answerWithin: 10_000,
      firstRetry: 10,
      longestRetry: 10,
      giveUpAfter: 10_000,
    });

    expect(steps).toBeGreaterThan(10);
    expect(forwarded.has("")).toBe(false);
    expect([...forwarded.values()].every((times) => times === 1)).toBe(true);
    expect(await answers(open(dir))).toEqual(before);
  } finally {
    await object.stop();
  }
});

test("a folder whose hex.db carries a move's triggers but no store.json isn't a home: it says what the folder is missing", async () => {
  filled(dir).db.close();
  const object = served();

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear);
    const twin = join(dir, "twin");
    mkdirSync(twin);
    writeFileSync(join(twin, "hex.db"), readFileSync(join(dir, MOVED)));
    expect(() => open(twin)).toThrow(MovedError);
    expect(() => fileIn(twin)).toThrow("store.json, which says which, isn't here");
  } finally {
    await object.stop();
  }
});

test("a move keeps every last write with the file it leaves, even while another process reads it", async () => {
  const file = filled(dir);
  file.db.close();
  const reader = new Database(join(dir, "hex.db"), { readonly: true });
  reader.run("begin");
  reader.query("select count(*) from messages").get();
  const object = served();

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear);
  } finally {
    reader.run("commit");
    reader.close();
    await object.stop();
  }

  const kept = new Database(join(dir, MOVED), { readonly: true });
  expect(kept.query("select count(*) as n from messages").get()).toEqual({ n: 1202 });
  expect(
    kept.query("select count(*) as n from sqlite_master where name glob 'moved_*'").get(),
  ).toEqual({
    n:
      3 *
      (await layout(async (text) => await Promise.resolve(kept.query(text).all()))).tables.length,
  });
  kept.close();
});

const offering = (offers: typeof OFFERS) =>
  served(objectStorage(), undefined, async (route, answer) => {
    const answered = await answer();

    return route === "version" ? Response.json({ ...(await answered.json()), offers }) : answered;
  });

test("hex store back brings every row home into hex.db, claiming hex first, and only then stops pointing at the object", async () => {
  filled(dir).db.close();
  const object = served();

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear);
    const hub = remote(dir, quick, false);
    await hub?.claim();
    await hub?.messages.deliver({ ...message, key: "telegram:-100:9", body: "only in the object" });
    writeFileSync(join(dir, "hex.db"), "a hex.db a killed move left");

    await backHome(dir, hear);

    expect(
      await thrown(hub?.messages.deliver({ ...message, key: "telegram:-100:10" }) ?? never),
    ).toBeInstanceOf(LostError);
  } finally {
    await object.stop();
  }

  expect(existsSync(join(dir, "store.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "store.json.back"), "utf-8"))).toMatchObject({
    name: "hex",
  });
  const kept = readdirSync(dir).filter((name) => /^hex\.db\.\d{14}$/u.test(name));
  expect(kept.map((name) => readFileSync(join(dir, name), "utf-8"))).toEqual([
    "a hex.db a killed move left",
  ]);

  const home = open(dir);
  expect(await home.messages.get("telegram:-100:9")).toMatchObject({ body: "only in the object" });
  expect((await Array.fromAsync(messagesSince(home))).flat()).toHaveLength(1203);

  await backHome(dir, hear);
  expect(heard.at(-1)).toContain("hex runs on");
});

test("hex store back that finds its copy differs from the object leaves hex on the object, and run again it finishes", async () => {
  filled(dir).db.close();
  let spoiled = false;

  const object = served(objectStorage(), undefined, async (route, answer, request) => {
    const asked = await request.clone().text();

    return spoiled && route === "sql" && asked.includes("typeof(")
      ? Response.json({ value: [] })
      : await answer();
  });

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear);
    spoiled = true;
    expect(await failure(backHome(dir, hear))).toContain("hex stays on the object");
    expect(existsSync(join(dir, "store.json"))).toBe(true);
    expect(existsSync(join(dir, "hex.db"))).toBe(false);

    spoiled = false;
    await backHome(dir, hear);
    expect(existsSync(join(dir, "store.json"))).toBe(false);
    expect((await Array.fromAsync(messagesSince(open(dir)))).flat()).toHaveLength(1202);
  } finally {
    await object.stop();
  }
});

test("a move refuses a Worker older than this hex, and goes into one newer", async () => {
  filled(dir).db.close();
  const older = offering({ ...OFFERS, methods: OFFERS.methods.slice(1) });

  try {
    const refused = await failure(move(dir, { url: older.url, name: "hex", key: KEY }, hear));
    expect(refused).toContain("the Worker runs an older hex's store");
    expect(refused).toContain(`it has no ${OFFERS.methods[0]}`);
    expect(existsSync(join(dir, "store.json"))).toBe(false);
  } finally {
    await older.stop();
  }

  const newer = offering({
    migrations: OFFERS.migrations + 1,
    methods: [...OFFERS.methods, "messages.later"],
  });

  try {
    await move(dir, { url: newer.url, name: "hex", key: KEY }, hear);
    expect(existsSync(join(dir, "store.json"))).toBe(true);
  } finally {
    await newer.stop();
  }
});

const mark = (step: number) => ({ id: "m-1", step });

const rows = (ids: number[]) =>
  JSON.stringify({ table: "t", columns: ["id"], rows: ids.map((id) => [id]) });

test("the object takes a move's step once: one sent again, or held back past a later one, changes nothing", () => {
  const object = recordsIn(objectStorage());

  object.moved("begin", "{}", mark(1));
  object.moved("schema", JSON.stringify({ statements: ["create table t (id integer)"] }), mark(2));
  expect(object.moved("rows", rows([1, 2]), mark(3))).toBe(2);
  expect(object.moved("rows", rows([1, 2]), mark(3))).toBe(true);
  expect(object.moved("rows", rows([3]), mark(4))).toBe(1);
  expect(object.moved("rows", rows([1, 2]), mark(3))).toBe(true);
  expect(object.read(sql("select count(*) as n from t"))).toEqual([{ n: 3 }]);
  expect(object.moved("rows", rows([4]), { id: "m-2", step: 3 })).toBe(1);
});

test("a hex that stops using a lease tool ends the lease with hex store lease clear, and a lease that isn't a whole number is refused", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);
  pointedAt(dir, object.url);

  try {
    process.env.HEX_STORE_LEASE = "7";
    await remote(dir, quick)?.claim();
    const plain = remote(dir, quick);
    expect(await thrown(plain?.claim() ?? never)).toBeInstanceOf(LostError);
    await unlease(dir);
    expect(await remote(dir, quick)?.claim()).toBe(2);
    process.env.HEX_STORE_LEASE = "seven";
    const malformed = await thrown(remote(dir, quick)?.claim() ?? never);
    expect(malformed).toBeInstanceOf(LostError);
    expect(String(malformed)).toContain('HEX_STORE_LEASE is "seven", not a whole number');
    expect(await unclaimed(dir).messages.deliver(message)).toBe(true);
  } finally {
    delete process.env.HEX_STORE_LEASE;
    await object.stop();
  }
});

test("a table of large rows is read a page of about 4 MB at a time", async () => {
  const db = new Database(":memory:");
  db.run("create table big (id integer primary key, body text)");

  for (let n = 1; n <= 12; n += 1) {
    db.query("insert into big (id, body) values (?, ?)").run(n, "a".repeat(1_000_000));
  }

  const read: Read = async (text) => await Promise.resolve(db.query(text).all());
  const [table] = (await layout(read)).tables;

  if (table === undefined) {
    throw new Error("no table");
  }

  const sizes = (await Array.fromAsync(pages(read, table))).map((page) => page.length);
  expect(sizes).toEqual([3, 3, 3, 3]);
});

test("a hub on a store older than its hex is told so at its claim, apart from an outage, and an older hex claims a newer store and runs", async () => {
  const storage = objectStorage();
  startedEmpty(storage);

  const claimOf = (claimant: string, needs: typeof OFFERS) =>
    JSON.stringify(recordsIn(storage, dir).claim(JSON.stringify({ claimant, needs })));

  expect(claimOf("newer", { ...OFFERS, migrations: OFFERS.migrations + 1 })).toContain(
    `this hex needs ${OFFERS.migrations + 1}`,
  );
  expect(claimOf("newer", { ...OFFERS, methods: [...OFFERS.methods, "messages.later"] })).toContain(
    "it has no messages.later",
  );
  expect(claimOf("older", { migrations: 1, methods: OFFERS.methods.slice(1) })).toEqual(
    JSON.stringify({ tenure: 1 }),
  );

  const object = served(storage);

  const front = (needs: typeof OFFERS) =>
    Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        const body = await request.text();

        return await fetch(new URL(pathname, object.url), {
          method: request.method,
          headers: request.headers,
          body: pathname.endsWith("/claim") ? JSON.stringify({ ...JSON.parse(body), needs }) : body,
        });
      },
    });

  const newer = front({ ...OFFERS, migrations: OFFERS.migrations + 1 });
  const older = front({ migrations: 1, methods: OFFERS.methods.slice(1) });

  try {
    pointedAt(dir, newer.url.origin);
    const refused = await thrown(remote(dir, quick)?.claim() ?? never);
    expect(refused).toBeInstanceOf(OtherStoreError);
    expect(refused).toBeInstanceOf(UnreachedError);
    expect(String(refused)).toContain("Deploy this hex's with hex store deploy");

    pointedAt(dir, older.url.origin);
    const store = remote(dir, quick, false);
    expect(await store?.claim()).toBe(2);
    expect(await store?.messages.deliver(message)).toBe(true);
  } finally {
    await newer.stop(true);
    await older.stop(true);
    await object.stop();
  }
});

test("a file whose schema lacks what this hex's SQL names refuses the call, so a hex that doesn't fit its hex.db stops and is rolled back rather than waiting", async () => {
  const file = new File(dir);
  file.db.run("drop index if exists untaken");
  file.db.run("alter table messages drop column held_for");
  await file.store.messages.deliver(message);
  const refused = await thrown(file.store.messages.hold(message.key, "s-1"));
  expect(refused).toBeInstanceOf(RefusedError);
  expect(refused).not.toBeInstanceOf(UnreachedError);
  expect(String(refused)).toContain("held_for");
});

test("an object whose store's code doesn't fit its own records can take nothing, so a hub waits for a deploy and sets no row aside as bad", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  storage.sql.exec("drop index if exists untaken");
  storage.sql.exec("alter table messages drop column held_for");
  const object = served(storage);
  pointedAt(dir, object.url);

  try {
    const store = remote(dir, quick, false);
    await store?.claim();
    await store?.messages.deliver(message);
    const failed = await thrown(store?.messages.hold(message.key, "s-1") ?? never);
    expect(failed).toBeInstanceOf(UnreachedError);
    expect(String(failed)).toContain("held_for");
  } finally {
    await object.stop();
  }
});

test("a second move sets the file an earlier one kept aside with its WAL, and each reads whole", async () => {
  const first = filled(dir);
  first.db.close();
  let reader = new Database(join(dir, "hex.db"), { readonly: true });
  reader.run("begin");
  reader.query("select count(*) from messages").get();
  const object = served();

  try {
    await move(dir, { url: object.url, name: "hex", key: KEY }, hear);
    reader.run("commit");
    reader.close();
    expect(existsSync(join(dir, `${MOVED}-wal`))).toBe(true);

    rmSync(join(dir, "store.json"));
    const again = new File(join(dir, "again"));
    again.messages.deliver({ ...message, key: "telegram:-100:7", body: "only in the second" });
    again.db.close();
    writeFileSync(join(dir, "hex.db"), readFileSync(join(dir, "again", "hex.db")));
    reader = new Database(join(dir, "hex.db"), { readonly: true });
    reader.run("begin");
    reader.query("select count(*) from messages").get();
    await move(dir, { url: object.url, name: "restored", key: KEY }, hear);
  } finally {
    reader.close();
    await object.stop();
  }

  const aside = readdirSync(dir).filter((name) => /^hex\.db\.moved\.\d{14}$/u.test(name));
  expect(aside).toHaveLength(1);

  const count = (name: string) => {
    const kept = new Database(join(dir, name), { readonly: true });

    const read = [
      kept.query("pragma integrity_check").get(),
      kept.query("select count(*) as n from messages").get(),
      kept.query("select count(*) > 0 as moved from sqlite_master where name glob 'moved_*'").get(),
    ];

    kept.close();

    return read;
  };

  expect(existsSync(join(dir, `${aside[0] ?? ""}-wal`))).toBe(true);
  expect(count(aside[0] ?? "")).toEqual([{ integrity_check: "ok" }, { n: 1202 }, { moved: 1 }]);
  expect(count(MOVED)).toEqual([{ integrity_check: "ok" }, { n: 1 }, { moved: 1 }]);
});

test("every message is read in pages of about 4 MB, so a log of large messages never comes back in one reply", async () => {
  const file = new File(dir);

  for (let n = 0; n < 10; n += 1) {
    file.messages.deliver({ ...message, key: `telegram:-100:${n}`, body: "a".repeat(1_000_000) });
  }

  const read = await Array.fromAsync(messagesSince(file.store));
  expect(read.map((page) => page.length)).toEqual([3, 3, 3, 1]);
  expect(read.flat().map((row) => row.key)).toEqual(file.messages.since().map((row) => row.key));
});

test("a backup reads through a client of its own: another process's word that the object is down doesn't stop it, and its own failure tells no one", async () => {
  const storage = objectStorage();
  startedEmpty(storage).call(raw("messages", "deliver", [message]));
  const object = served(storage);
  pointedAt(dir, object.url);
  writeFileSync(join(dir, "store.down"), "another process found it down\n");

  try {
    expect(await thrown(remote(dir, quick)?.messages.untaken() ?? never)).toBeInstanceOf(
      UnreachedError,
    );
    await backup(dir, "2026-11-17");
    const copy = new Database(join(dir, "backups", "hex-2026-11-17.db"), { readonly: true });
    expect(copy.query("select key from messages").all()).toEqual([{ key: message.key }]);
    copy.close();
  } finally {
    await object.stop();
  }

  rmSync(join(dir, "store.down"));
  const gone = join(dir, "gone");
  pointedAt(gone, "http://127.0.0.1:9");
  expect(await thrown(unclaimed(gone).messages.untaken())).toBeInstanceOf(UnreachedError);
  expect(existsSync(join(gone, "store.down"))).toBe(false);
});
