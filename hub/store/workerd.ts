import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { File, messagesSince, open } from "../store.ts";
import { until } from "../until.ts";
import { OFFERS } from "./domains.ts";
import { LostError, RefusedError, UnaskedError, UnreachedError } from "./errors.ts";
import type { NewRow } from "./messages.ts";
import { move } from "./move.ts";
import { remote, unlease } from "./remote.ts";
import { resetting } from "./resetting.ts";

const KEY = "a key long enough that nobody guesses it";
const HEX = join(import.meta.dir, "../..");

const WRANGLER =
  /^wrangler="bunx (wrangler@[^"]+)"$/mu.exec(readFileSync(join(HEX, "bin/hex"), "utf-8"))?.[1] ??
  "wrangler@4";

const QUICK = { answerWithin: 1000, firstRetry: 100, longestRetry: 100, heartbeat: 200 };
const scratch = mkdtempSync(join(tmpdir(), "workerd-"));
const runtimes: ReturnType<typeof Bun.spawn>[] = [];
const auth = { authorization: `Bearer ${KEY}` };
let url = "";

const freePort = async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);

  return port;
};

async function runtime(vars: Record<string, string>) {
  const port = await freePort();
  const at = `http://127.0.0.1:${port}`;
  const persist = mkdtempSync(join(scratch, "persist-"));
  const settings = Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]);

  runtimes.push(
    Bun.spawn(
      [
        "bunx",
        WRANGLER,
        "dev",
        "--config",
        join(HEX, "hub/store/wrangler.jsonc"),
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persist,
        "--show-interactive-dev-session=false",
        ...settings,
      ],
      { stdout: "ignore", stderr: "ignore" },
    ),
  );

  await until(
    async () =>
      await fetch(at).then(
        () => true,
        () => false,
      ),
  );

  return at;
}

const Answer = z.object({ value: z.unknown().optional(), error: z.string().optional() });
const Version = z.object({ version: z.string().nullable(), migrations: z.number().nullable() });

const sqlIn = async (name: string, text: string, bound: unknown[] = []) =>
  Answer.parse(
    await (
      await fetch(`${url}/${name}/sql`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text, bound }),
      })
    ).json(),
  );

const sql = async (text: string) => await sqlIn("hex", text);

const version = async () =>
  Version.parse(await (await fetch(`${url}/hex/version`, { headers: auth })).json());

async function thrown(pending: Promise<unknown> | undefined): Promise<Error | string> {
  try {
    await pending;
  } catch (error) {
    return error instanceof Error ? error : String(error);
  }

  return "it answered";
}

function pointedAt(name: string, address = url) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "store.json"), JSON.stringify({ url: address, name: "hex", key: KEY }));

  return dir;
}

beforeAll(async () => {
  url = await runtime({ KEY, VERSION: "v-test" });
}, 120_000);

afterAll(() => {
  for (const running of runtimes) {
    running.kill();
  }

  rmSync(scratch, { recursive: true, force: true });
});

test("a Worker with no key, or one too short to guess, answers no one", async () => {
  for (const vars of [{}, { KEY: "test-key" }]) {
    const at = await runtime(vars);

    const statuses = await Promise.all(
      ["Bearer undefined", "Bearer test-key", "Bearer "].map(async (authorization) => {
        const answer = await fetch(`${at}/hex/sql`, {
          method: "POST",
          headers: { authorization },
          body: '{"text":"select 1"}',
        });

        return answer.status;
      }),
    );

    expect(statuses).toEqual([503, 503, 503]);
  }
}, 120_000);

test("a wrong key gets 401, and an empty object answers its version with no migrations", async () => {
  const wrong = await fetch(`${url}/hex/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}x` },
    body: "{}",
  });

  expect(wrong.status).toBe(401);
  expect(await version()).toEqual({ version: "v-test", migrations: null });
});

test("hex sql changes nothing on the object, settings included, and still reads them", async () => {
  for (const text of [
    "pragma foreign_keys(0)",
    "pragma foreign_keys = off",
    "pragma ignore_check_constraints = 1",
    "select 1; pragma foreign_keys = off",
    "pragma optimize",
  ]) {
    expect((await sql(text)).error).toContain("hex sql");
  }

  const columns = z.array(z.unknown()).parse((await sql("pragma table_info('_home')")).value);

  expect(await sql("pragma foreign_keys")).toEqual({ value: [{ foreign_keys: 1 }] });
  expect(columns).not.toHaveLength(0);
});

const message: NewRow = {
  key: "telegram:-100:42",
  to: "-100:7",
  from: "telegram",
  body: "hello",
  author: "owner",
  meta: { user: "v" },
};

test("a move carries every row, a lost last reply is finished by running it again, a used object takes no other, and a backup goes into a new name", async () => {
  const dir = join(scratch, "state");
  const records = new File(dir);
  records.messages.deliver(message);

  const task = records.tasks.create({
    title: "Fix",
    message: message.key,
    quote: "hello",
    owner: "-100:7",
  });

  records.tasks.addAgents(task.id, ["agent-12345678"], "-100:7");

  for (let n = 0; n < 1300; n += 1) {
    records.messages.deliver({
      ...message,
      key: `telegram:-100:${1000 + n}`,
      body: `line ${n} ${"x".repeat(n % 50)}`,
    });
  }

  records.db.close();

  let losing = 0;

  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      const answer = await fetch(`${url}${pathname}`, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });

      const lost =
        (pathname.endsWith("/move/arrived") && losing === 2) ||
        (pathname.endsWith("/move/state") && losing === 1);

      if (lost) {
        losing -= 1;

        return new Response("<html>bad gateway</html>", { status: 502 });
      }

      return new Response(await answer.text(), { status: answer.status });
    },
  });

  const finished: string[] = [];

  const said = (line: string) => {
    finished.push(line);
  };

  const into = async (folder: string, name: string, givingUp = false) => {
    await move(
      folder,
      { url: proxy.url.origin, name, key: KEY },
      said,
      givingUp
        ? { answerWithin: 60_000, firstRetry: 10, longestRetry: 10, giveUpAfter: 0 }
        : undefined,
    );
  };

  try {
    await into(dir, "hex");

    const store = open(dir);
    const pages = await Array.fromAsync(messagesSince(store));
    const moved = await version();

    expect((await store.messages.get(message.key))?.body).toBe("hello");
    expect(pages.map((page) => page.length)).toEqual([500, 500, 301]);
    expect(moved.version).toBe("v-test");
    expect(moved.migrations).toBeGreaterThan(40);

    const back = join(scratch, "back");
    mkdirSync(back);
    await store.copy(join(back, "hex.db"));

    const copy = new Database(join(back, "hex.db"), { readonly: true });
    expect(copy.query("select count(*) as n from messages").get()).toEqual({ n: 1301 });
    expect(copy.query("pragma foreign_key_check").all()).toEqual([]);
    copy.close();

    const again = join(scratch, "again");
    mkdirSync(again);
    writeFileSync(join(again, "hex.db"), readFileSync(join(back, "hex.db")));
    expect(String(await thrown(into(again, "hex")))).toContain("has served a hub");

    losing = 2;
    expect(String(await thrown(into(again, "restored", true)))).toContain("answered 502");

    finished.length = 0;
    await into(again, "restored");
    expect(finished).toContain(
      "the object restored has every row from a move whose last reply was lost",
    );
    expect((await open(again).messages.get(message.key))?.body).toBe("hello");
  } finally {
    await proxy.stop(true);
  }
}, 120_000);

test("the runtime answers a watch socket's ping without waking the object, and a watch with heartbeats hears each write", async () => {
  const dir = pointedAt("watching");

  const pong = await new Promise<string>((resolve) => {
    // SAFETY: Bun's WebSocket takes headers where the web's, whose type this is, takes protocols: https://bun.com/docs/api/websockets#connect-to-a-websocket-server
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- the two types share nothing to narrow through
    const socket = new WebSocket(`${url.replace("http", "ws")}/hex/watch`, {
      headers: auth,
    } as unknown as string[]);

    socket.addEventListener("open", () => {
      socket.send("ping");
    });

    socket.addEventListener("message", ({ data }) => {
      resolve(String(data));
      socket.close();
    });

    setTimeout(() => {
      resolve("nothing");
    }, 3000);
  });

  expect(pong).toBe("pong");

  const writer = remote(dir);
  const watched = remote(dir, QUICK);
  let rang = 0;

  const stop = watched?.watch(() => {
    rang += 1;
  });

  await Bun.sleep(1500);
  const before = rang;
  await writer?.messages.deliver({ ...message, key: "telegram:-100:9999", body: "rings" });
  await Bun.sleep(300);
  stop?.();

  expect([before, rang]).toEqual([1, 2]);
}, 30_000);

test("numbers bound as the runtime binds them, as doubles, still find their rows", async () => {
  const store = remote(pointedAt("numbers"));

  await store?.questions.ask({
    app: "telegram",
    thread: "-100:7",
    message: 50,
    text: "Ship?",
    options: ["Yes", "No"],
  });

  expect((await store?.questions.get("telegram", "-100:7", 50))?.text).toBe("Ship?");
});

test("a store whose object is gone fails at once after the first call, and synced rejects", async () => {
  const far = remote(pointedAt("gone", `http://127.0.0.1:${await freePort()}`), QUICK);

  expect(await thrown(far?.messages.untaken())).toBeInstanceOf(UnreachedError);

  const started = performance.now();
  expect(await thrown(far?.messages.untaken())).toBeInstanceOf(UnaskedError);
  expect(performance.now() - started).toBeLessThan(QUICK.answerWithin / 4);
  expect(await thrown(far?.synced())).toBeInstanceOf(UnreachedError);
});

test("one call whose connection resets fails alone, and the calls behind it, here and in another process, reach the store", async () => {
  const dir = await movedInto("reset");
  const front = await resetting(url);
  writeFileSync(
    join(dir, "store.json"),
    JSON.stringify({ url: front.url, name: "reset", key: KEY }),
  );

  try {
    const hub = remote(dir, QUICK);
    await hub?.claim();
    front.arm();
    const reset = await thrown(hub?.messages.deliver(message));
    expect(reset).toBeInstanceOf(UnreachedError);
    expect(reset).not.toBeInstanceOf(UnaskedError);
    expect(front.resets()).toBe(1);
    expect(existsSync(join(dir, "store.down"))).toBe(false);

    expect(await hub?.messages.deliver(message)).toBe(true);
    await hub?.synced();
    expect(await remote(dir, QUICK)?.messages.get(message.key)).toMatchObject({
      body: message.body,
    });
  } finally {
    await front.stop();
  }
}, 60_000);

const progress: string[] = [];

const quiet = (line: string) => {
  progress.push(line);
};

async function movedInto(name: string) {
  const dir = join(scratch, `${name}-state`);
  new File(dir).db.close();
  await move(dir, { url, name, key: KEY }, quiet);

  return dir;
}

const MIB = 1024 * 1024;

test("the store says which no it gave: a refused call is refused, a wrong key or an empty object is unreached", async () => {
  const store = remote(await movedInto("refusals"), QUICK);
  const wrong = join(scratch, "wrong-key");
  mkdirSync(wrong);
  writeFileSync(
    join(wrong, "store.json"),
    JSON.stringify({ url, name: "refusals", key: `${KEY} but not it` }),
  );

  const empty = join(scratch, "empty");
  mkdirSync(empty);
  writeFileSync(join(empty, "store.json"), JSON.stringify({ url, name: "nobody", key: KEY }));

  expect(await thrown(store?.messages.deliver({ ...message, key: "42" }))).toBeInstanceOf(
    RefusedError,
  );
  await store?.synced();
  expect(await thrown(remote(wrong, QUICK)?.messages.untaken())).toBeInstanceOf(UnreachedError);
  expect(await thrown(remote(empty, QUICK)?.messages.untaken())).toBeInstanceOf(UnreachedError);
}, 60_000);

test("a tenure the object didn't give out gets the object's 409, and never wedges it", async () => {
  const dir = await movedInto("tenures");

  for (const insane of ["1e999", "Infinity", "abc", "-1"]) {
    const answer = await fetch(`${url}/tenures/call`, {
      method: "POST",
      headers: { ...auth, "hex-tenure": insane },
      body: JSON.stringify({ domain: "messages", method: "untaken", args: [] }),
    });

    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ lost: true });
  }

  expect((await fetch(`${url}/tenures/version`, { headers: auth })).status).toBe(200);
  expect(await remote(dir, QUICK)?.messages.untaken()).toEqual([]);
}, 60_000);

test("a hub that claims refuses every hub that claimed before it, a lease never goes back, and a hook is never refused", async () => {
  const dir = await movedInto("claims");

  const lease = (value?: string) => {
    if (value === undefined) {
      delete process.env.HEX_STORE_LEASE;
    } else {
      process.env.HEX_STORE_LEASE = value;
    }

    return remote(dir, QUICK);
  };

  const first = lease("6");
  const second = lease("6");
  const stale = lease("5");
  const plain = lease();
  const hook = lease();

  await first?.claim();
  expect(await first?.messages.deliver(message)).toBe(true);
  await second?.claim();
  expect(
    await thrown(first?.messages.deliver({ ...message, key: "telegram:-100:43", body: "late" })),
  ).toBeInstanceOf(LostError);
  expect(await thrown(first?.synced())).toBeInstanceOf(LostError);
  expect(await second?.messages.get("telegram:-100:43")).toBeNull();
  expect(await thrown(stale?.claim())).toBeInstanceOf(LostError);
  expect(await hook?.messages.deliver({ ...message, key: "telegram:-100:44", body: "hook" })).toBe(
    true,
  );
  expect(String(await thrown(plain?.claim()))).toContain("hex runs under lease 6");
  expect(await second?.messages.untaken()).not.toHaveLength(0);
  await unlease(dir);
  await lease()?.claim();
  expect(await thrown(second?.messages.untaken())).toBeInstanceOf(LostError);
  await lease("1")?.claim();
  expect(String(await thrown(lease("one")?.claim()))).toContain("not a whole number");
}, 60_000);

test("hex sql reads what only reads, and nothing it's given changes the object's settings", async () => {
  for (const text of [
    "explain pragma ignore_check_constraints = on",
    ";pragma recursive_triggers = 1",
    "explain query plan pragma case_sensitive_like = 1",
    "delete from _home",
    "with x as (select 1) delete from _home",
  ]) {
    expect((await sql(text)).error).toContain("hex sql");
  }

  expect(await sql("pragma ignore_check_constraints")).toEqual({
    value: [{ ignore_check_constraints: 0 }],
  });
  expect(await sql("pragma recursive_triggers")).toEqual({ value: [{ recursive_triggers: 0 }] });
  expect(await sql("select replace('abc', 'a', 'b') as r")).toEqual({ value: [{ r: "bbc" }] });
});

test("whole numbers keep their type in the object, a late message keeps its time, and the log reads through its index", async () => {
  const store = remote(await movedInto("records"), QUICK);
  const at = "2026-11-17T10:00:00.000Z";

  await store?.questions.ask({
    app: "telegram",
    thread: "-100:7",
    message: 50,
    text: "Ship?",
    options: ["Yes"],
  });
  await store?.messages.deliver({ ...message, at }, "s-9");

  expect(await sqlIn("records", "select typeof(message) as type from questions")).toEqual({
    value: [{ type: "integer" }],
  });
  expect((await store?.messages.get(message.key))?.taken?.at).toBe(at);
  expect(
    JSON.stringify(
      await sqlIn(
        "records",
        "explain query plan select * from messages where (at, n) > ('', 0) order by at, n limit 500",
      ),
    ),
  ).toContain("messages_in_time");
}, 60_000);

test("the object keeps a value or row of 8 MiB and refuses one past it, as the stand-in does", async () => {
  const store = remote(await movedInto("sizes"), { ...QUICK, answerWithin: 60_000 });
  const length = "select length(?) as n";

  expect(await sqlIn("sizes", length, ["a".repeat(8 * MIB)])).toEqual({ value: [{ n: 8 * MIB }] });
  expect((await sqlIn("sizes", length, ["a".repeat(8 * MIB + 64 * 1024)])).error).toContain(
    "too big",
  );
  expect(
    await store?.messages.deliver({
      ...message,
      key: "telegram:-100:8",
      body: "a".repeat(8 * MIB - 1024),
    }),
  ).toBe(true);
  expect(
    await thrown(
      store?.messages.deliver({
        ...message,
        key: "telegram:-100:9",
        body: "a".repeat(8 * MIB + 64 * 1024),
      }),
    ),
  ).toBeInstanceOf(RefusedError);
}, 120_000);

test("a process that finds the object not answering tells the next, which fails at once", async () => {
  const dir = pointedAt("told", `http://127.0.0.1:${await freePort()}`);
  expect(await thrown(remote(dir, QUICK)?.clock.now())).toBeInstanceOf(UnreachedError);

  const started = performance.now();
  expect(await thrown(remote(dir, QUICK)?.clock.now())).toBeInstanceOf(UnaskedError);
  expect(performance.now() - started).toBeLessThan(QUICK.answerWithin / 4);
});

test("a move rides out Cloudflare's own pages partway through, and the object takes each step once", async () => {
  const dir = join(scratch, "edge-state");
  const records = new File(dir);

  for (let n = 0; n < 1200; n += 1) {
    records.messages.deliver({ ...message, key: `telegram:-100:${n}`, body: `line ${n}` });
  }

  records.db.close();

  const forwarded = new Map<string, number>();
  let steps = 0;

  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const stepping = pathname.includes("/move/") && !pathname.endsWith("/move/state");
      steps += stepping ? 1 : 0;

      if (stepping && steps % 4 === 1) {
        return new Response("<html>404 Not Found</html>", { status: 404 });
      }

      const mark = request.headers.get("hex-move") ?? "";

      if (stepping) {
        forwarded.set(mark, (forwarded.get(mark) ?? 0) + 1);
      }

      const answer = await fetch(`${url}${pathname}`, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });

      const text = await answer.text();

      return stepping && steps % 4 === 3
        ? new Response("<html>404 Not Found</html>", { status: 404 })
        : new Response(text, { status: answer.status });
    },
  });

  try {
    await move(dir, { url: proxy.url.origin, name: "edge", key: KEY }, quiet, {
      answerWithin: 60_000,
      firstRetry: 10,
      longestRetry: 10,
      giveUpAfter: 30_000,
    });

    expect(steps).toBeGreaterThan(8);
    expect([...forwarded.values()].every((times) => times === 1)).toBe(true);
    expect(await remote(dir, QUICK)?.messages.get("telegram:-100:1199")).toMatchObject({
      body: "line 1199",
    });
  } finally {
    await proxy.stop(true);
  }
}, 120_000);

test("the object says what its store offers, the migrations and methods this checkout has", async () => {
  const answer = z
    .object({ offers: z.unknown() })
    .parse(await (await fetch(`${url}/hex/version`, { headers: auth })).json());

  expect(answer.offers).toEqual(OFFERS);
});

test("words a lost reply took mid-turn come back when the take is made again with the same time", async () => {
  const store = remote(await movedInto("held"), QUICK);
  const at = "2026-11-17T10:00:00.000Z";

  await store?.messages.deliver(message);
  await store?.messages.hold(message.key, "s-1");
  await store?.messages.takeHeld(message.to, "s-1", at);

  expect((await store?.messages.takeHeld(message.to, "s-1", at))?.map((row) => row.key)).toEqual([
    message.key,
  ]);
}, 60_000);

const claimNeeding = async (claimant: string, needs: typeof OFFERS) =>
  await fetch(`${url}/contracts/claim`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ claimant, needs }),
  });

test("a claim from a hex newer than the object's store is answered as another store, apart from an outage, and one from an older hex is served", async () => {
  await movedInto("contracts");

  for (const needs of [
    { ...OFFERS, migrations: OFFERS.migrations + 1 },
    { ...OFFERS, methods: [...OFFERS.methods, "messages.later"] },
  ]) {
    const refused = await claimNeeding("newer", needs);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ every: true, other: true });
  }

  const older = await claimNeeding("older", { migrations: 1, methods: OFFERS.methods.slice(1) });
  expect(older.status).toBe(200);
  expect(await older.json()).toEqual({ value: 1 });
}, 60_000);

test("hex store back, run as its command, brings the object's rows home into hex.db, and the hub that held hex is lost", async () => {
  const dir = await movedInto("back");
  const hub = remote(dir, QUICK, false);
  await hub?.claim();
  await hub?.messages.deliver(message);

  const backed = Bun.spawn(["bun", join(HEX, "hub/store/back.ts"), dir], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await backed.exited).toBe(0);
  expect(await new Response(backed.stdout).text()).toContain("hex's records are in");
  expect(existsSync(join(dir, "store.json"))).toBe(false);
  expect(
    await thrown(hub?.messages.deliver({ ...message, key: "telegram:-100:2" })),
  ).toBeInstanceOf(LostError);
  expect((await Array.fromAsync(messagesSince(open(dir)))).flat().map((row) => row.key)).toEqual([
    message.key,
  ]);
}, 60_000);

test("an object whose store's code doesn't fit its own records answers every call alike, never as a bad row", async () => {
  const dir = join(scratch, "unfit-state");
  const file = new File(dir);
  file.db.run("drop index if exists untaken");
  file.db.run("alter table messages drop column held_for");
  file.db.close();
  await move(dir, { url, name: "unfit", key: KEY }, quiet);

  const store = remote(dir, QUICK, false);
  await store?.claim();
  await store?.messages.deliver(message);
  const failed = await thrown(store?.messages.hold(message.key, "s-1"));
  expect(failed).toBeInstanceOf(UnreachedError);
  expect(String(failed)).toContain("held_for");
}, 60_000);

test("the log of large messages is read in pages of about 4 MB", async () => {
  const store = remote(await movedInto("pages"), { ...QUICK, answerWithin: 60_000 });

  for (let n = 0; n < 7; n += 1) {
    await store?.messages.deliver({
      ...message,
      key: `telegram:-100:${n}`,
      body: "a".repeat(1_000_000),
    });
  }

  const read = store === undefined ? [] : await Array.fromAsync(messagesSince(store));
  expect(read.map((page) => page.length)).toEqual([3, 3, 1]);
}, 120_000);
