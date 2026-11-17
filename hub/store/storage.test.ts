import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DurableObject, Namespace } from "cloudflare:workers";

import { File, messagesSince, open } from "../store.ts";
import type { NewRow } from "../store.ts";
import { until } from "../until.ts";
import { bring, layout } from "./carry.ts";
import type { Read } from "./carry.ts";
import { objectStorage } from "./fake.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { move, MOVED } from "./move.ts";
import { LostError, remote, UnreachedError } from "./remote.ts";
import { recordsIn } from "./storage.ts";
import type { Storage } from "./storage.ts";
import { client } from "./wire.ts";
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
  expect(await failure(store.messages.deliver({ ...message, key: "42" }))).toContain("Error");
  expect(wrote()).toBe(false);
  expect(object.call(raw("messages", "constructor"))).toEqual({
    reply: { error: "the store has no messages.constructor" },
    wrote: false,
  });
  expect(object.call(raw("files", "list"))).toEqual({
    reply: { error: "the store has no files.list" },
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

test("a read sees the records and changes nothing, even one that writes", () => {
  const object = startedEmpty();
  object.call(raw("messages", "deliver", [message]));
  expect(object.read(sql('select key, "to" from messages where key = ?', message.key))).toEqual([
    { key: message.key, to: message.to },
  ]);
  expect(object.read(sql("delete from messages returning key"))).toEqual([{ key: message.key }]);
  expect(object.read(sql("update _home set tenure = 9 returning tenure"))).toEqual([{ tenure: 9 }]);
  expect(object.read(sql("drop table messages"))).toEqual([]);
  expect(object.records()?.messages.get(message.key)).toMatchObject({ body: message.body });
  expect(object.lostTo(1)).toBeUndefined();
  expect(() => object.read(sql("pragma user_version = 0"))).toThrow("hex sql");
  expect(() => object.read("not json")).toThrow();
  expect(object.call(raw("messages", "take", [message.key, "s-1"]))).toMatchObject({
    reply: { value: true },
    wrote: true,
  });
});

test("a hub on an older tenure than the object has seen lost hex, and nothing it sends is taken", () => {
  const object = startedEmpty();
  expect(object.lostTo(undefined)).toBeUndefined();
  expect(object.lostTo(0)).toBeUndefined();
  expect(object.lostTo(3)).toBeUndefined();
  expect(object.lostTo(3)).toBeUndefined();
  expect(object.lostTo(undefined)).toBeUndefined();
  expect(object.lostTo(2)).toBe("tenure 2 no longer holds hex: tenure 3 does");
  expect(object.lostTo(4)).toBeUndefined();
  expect(object.lostTo(3)).toBe("tenure 3 no longer holds hex: tenure 4 does");
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
  });
  object.call(raw("messages", "untaken"));
  expect(object.moved("state", "{}")).toMatchObject({ served: true });
  expect(() => object.moved("begin", "{}")).toThrow("has served a hub");
});

test("a tenure the object has seen holds through its restarts", () => {
  const storage = objectStorage();
  startedEmpty(storage).lostTo(5);
  expect(recordsIn(storage, dir).lostTo(4)).toBe("tenure 4 no longer holds hex: tenure 5 does");
});

type Between = (route: string, answer: () => Promise<Response>) => Promise<Response>;

function served(storage = objectStorage(), env?: Omit<Env, "STORE">, between?: Between) {
  const objects = new Map<string, InstanceType<typeof Records>>();

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
                storage: name === "hex" ? storage : objectStorage(),
                acceptWebSocket: () => {},
                getWebSockets: () => [],
                setWebSocketAutoResponse: () => {},
              },
              named,
            );

          objects.set(name, records);
          const route = new URL(request.url).pathname.split("/").slice(2).join("/");
          const answer = async () => await records.fetch(request);

          return between === undefined ? await answer() : await between(route, answer);
        },
      }),
    },
  };

  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, named) });

  return {
    storage,
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
    expect(await failure(move(again, { ...to, name: "again" }, hear))).toContain("answered 502");
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
    expect(await failure(move(changed, { ...to, name: "changed" }, hear))).toContain(
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
    ).toEqual({ version: "v7", migrations: appendOnlyMigrations.length });
    expect((await post("/hex/call", "{}", { "hex-tenure": "2" })).status).toBe(200);

    const refused = await post("/hex/call", raw("messages", "deliver", [message]), {
      "hex-tenure": "1",
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "tenure 1 no longer holds hex: tenure 2 does",
    });
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
    expect(await failure(store.messages.deliver({ ...message, key: "42" }))).not.toContain(
      "UnreachedError",
    );
    await store.synced();
  } finally {
    await front.stop(true);
    await object.stop();
  }
});

test("a store whose tenure the object refused is lost for good: every call after it and synced say so at once", async () => {
  const storage = objectStorage();
  startedEmpty(storage).lostTo(3);
  const object = served(storage);
  pointedAt(dir, object.url);
  process.env.HEX_STORE_TENURE = "2";
  const store = remote(dir, quick);
  expect(process.env.HEX_STORE_TENURE).toBeUndefined();

  try {
    if (store === undefined) {
      throw new Error("no store.json");
    }

    const refused = await thrown(store.messages.deliver(message));
    expect(refused).toBeInstanceOf(LostError);
    expect(String(refused)).toContain("tenure 2 no longer holds hex: tenure 3 does");
    expect(await thrown(store.clock.now())).toBeInstanceOf(LostError);
    expect(await thrown(store.synced())).toBeInstanceOf(LostError);
    expect(recordsIn(storage, dir).records()?.messages.untaken()).toEqual([]);
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
  let answering = false;

  const server = Bun.serve({
    port: 0,
    fetch: (request, at) => (at.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: () => {
        opened += 1;
      },
      message: (socket, data) => {
        if (answering && data === "ping") {
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

    answering = true;
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
  ];

  for (const text of refused) {
    expect(() => object.read(sql(text))).toThrow("hex sql");
  }

  expect(object.read(sql("select ';' as semicolon -- ; pragma foreign_keys = off"))).toEqual([
    { semicolon: ";" },
  ]);
  expect(object.read(sql("pragma table_info('_home')")).length).toBeGreaterThan(0);
  expect(object.read(sql("pragma foreign_keys"))).toEqual([{ foreign_keys: 1 }]);
  expect(storage.sql.exec("pragma foreign_keys").toArray()).toEqual([{ foreign_keys: 1 }]);

  for (const text of refused) {
    expect(await failure(file.store.read(text))).toContain("hex sql");
  }

  expect(file.db.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(await file.store.read("pragma table_info('messages')")).not.toEqual([]);
});

test("the stand-in refuses what the runtime refuses: more than 100 variables, statements over 100 KB, values over 2.2 MB, and it binds numbers as doubles", () => {
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
  expect(() => run.exec("select length(?) as n", "a".repeat(2_200_001))).toThrow("too big");
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
  const { Database } = await import("bun:sqlite");
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
  const pages = await Array.fromAsync(messagesSince(file.store));
  expect(pages.map((page) => page.length)).toEqual([500, 500, 202]);
  expect(pages.flat()).toEqual(file.messages.since());
  const later = pages[1]?.[0]?.at ?? "";
  expect((await Array.fromAsync(messagesSince(file.store, later))).flat()).toEqual(
    file.messages.since(later),
  );
});
