import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DurableObject, Namespace } from "cloudflare:workers";

import { File, open } from "../store.ts";
import type { NewRow } from "../store.ts";
import { objectStorage } from "./fake.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { move, MOVED } from "./move.ts";
import { recordsIn } from "./storage.ts";
import type { Storage } from "./storage.ts";
import { client } from "./wire.ts";
import type { Client } from "./wire.ts";

type State = ConstructorParameters<typeof DurableObject>[0];

type Env = { KEY: string; STORE: Namespace };

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
  expect(() => object.read(sql("pragma user_version = 0"))).toThrow("not authorized");
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

test("a tenure the object has seen holds through its restarts", () => {
  const storage = objectStorage();
  startedEmpty(storage).lostTo(5);
  expect(recordsIn(storage, dir).lostTo(4)).toBe("tenure 4 no longer holds hex: tenure 5 does");
});

function served(storage = objectStorage()) {
  const env: Env = {
    KEY: "the key",
    STORE: { idFromName: () => ({}), get: () => records },
  };

  const sockets: WebSocket[] = [];

  const records = new Records(
    {
      storage,
      acceptWebSocket: (socket) => {
        sockets.push(socket);
      },
      getWebSockets: () => sockets,
    },
    env,
  );

  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env) });

  return {
    storage,
    url: server.url.href,
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
    await move(dir, object.url, "the key", (line) => {
      said.push(line);
    });
    expect(said.at(-1)).toContain(`hex.db is kept as ${MOVED}`);
    expect(existsSync(join(dir, "hex.db"))).toBe(false);
    expect(existsSync(join(dir, MOVED))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"))).toEqual({
      url: object.url,
      key: "the key",
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

test("a move refuses a hex.db this hex hasn't migrated, a folder whose records moved already, and an object that has records", async () => {
  const object = served();

  try {
    const file = new File(dir);
    file.db.run("pragma user_version = 3");
    file.db.close();
    expect(await failure(move(dir, object.url, "the key", hear))).toContain(
      `hex.db is at migration 3 and this hex at ${appendOnlyMigrations.length}`,
    );
    expect(existsSync(join(dir, "store.json"))).toBe(false);

    const other = join(dir, "other");
    filled(other).db.close();
    await move(other, object.url, "the key", hear);
    expect(await failure(move(other, object.url, "the key", hear))).toContain(
      "this folder's records have moved",
    );

    const third = join(dir, "third");
    filled(third).db.close();
    expect(await failure(move(third, object.url, "the key", hear))).toContain(
      "has records already",
    );
    expect(existsSync(join(third, "hex.db"))).toBe(true);
    expect(existsSync(join(third, "store.json"))).toBe(false);
  } finally {
    await object.stop();
  }
});

test("a move starts over from what an earlier one left, and only rows that name rows that arrived are taken", () => {
  const object = recordsIn(objectStorage());

  const schema = (...statements: string[]) =>
    object.moved("schema", JSON.stringify({ statements }));

  expect(object.moved("begin", "{}")).toBe(true);
  schema(
    "create table parents (id integer primary key)",
    "create table children (id integer primary key, parent integer not null references parents (id))",
  );
  expect(
    object.moved(
      "rows",
      JSON.stringify({ table: "children", columns: ["id", "parent"], rows: [[1, 7]] }),
    ),
  ).toBe(1);
  expect(() => object.moved("arrived", JSON.stringify({ version: 0 }))).toThrow(
    "1 rows name a row that isn't there",
  );
  expect(object.records()).toBeUndefined();
  expect(object.moved("begin", "{}")).toBe(true);
  expect(
    object.read(sql("select name from sqlite_master where substr(name, 1, 1) <> '_'")),
  ).toEqual([]);
  expect(() =>
    object.moved("rows", JSON.stringify({ table: "x; drop", columns: [], rows: [] })),
  ).toThrow();
  expect(() => object.moved("elsewhere", "{}")).toThrow("hex's store has no move/elsewhere");
});

test("the object answers only its owner's key, and refuses a hub that lost hex before reading what it sent", async () => {
  const storage = objectStorage();
  startedEmpty(storage);
  const object = served(storage);

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, object.url), {
      method: "POST",
      headers: { authorization: "Bearer the key", ...headers },
      body,
    });

  try {
    expect((await post("/call", "{}", { authorization: "Bearer another" })).status).toBe(401);
    expect(await (await post("/call", raw("messages", "untaken"))).json()).toEqual({
      value: [],
    });
    expect((await post("/call", "{}", { "hex-tenure": "2" })).status).toBe(200);

    const refused = await post("/call", raw("messages", "deliver", [message]), {
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
});
