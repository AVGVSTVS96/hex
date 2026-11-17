import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { File, messagesSince, open } from "../store.ts";
import { until } from "../until.ts";
import { UnreachedError } from "./errors.ts";
import type { NewRow } from "./messages.ts";
import { move } from "./move.ts";
import { remote } from "./remote.ts";

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

const sql = async (text: string) =>
  Answer.parse(
    await (
      await fetch(`${url}/hex/sql`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text, bound: [] }),
      })
    ).json(),
  );

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

  const into = async (folder: string, name: string) => {
    await move(folder, { url: proxy.url.origin, name, key: KEY }, said);
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
    expect(String(await thrown(into(again, "restored")))).toContain("answered 502");

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
  expect(await thrown(far?.messages.untaken())).toBeInstanceOf(UnreachedError);
  expect(performance.now() - started).toBeLessThan(20);
  expect(await thrown(far?.synced())).toBeInstanceOf(UnreachedError);
});
