import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { arrived, open, socketsIn } from "./door.ts";

type Server = ReturnType<typeof Bun.serve>;

let state: string;
let door: Server;
let hub: Server | undefined;
let asked: string[];

const startHub = (name: string, hold = Promise.resolve()) => {
  hub = Bun.serve({
    unix: socketsIn(state).chats,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      const sent = await request.text();
      const token = request.headers.get("authorization") ?? "";
      asked.push([name, request.method, pathname + search, token, sent].filter(Boolean).join(" "));
      await hold;

      return Response.json({ from: name }, { status: request.method === "POST" ? 201 : 200 });
    },
  });

  arrived(state);
};

const stopHub = async () => {
  await hub?.stop(true);
  hub = undefined;
};

const ask = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${door.port}${path}`, init);

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "door-"));
  asked = [];
  door = open(state, 0);
});

afterEach(async () => {
  await stopHub();
  await door.stop(true);
  rmSync(state, { recursive: true, force: true });
});

test("the hub's answer passes through as it is, with what the keyboard sent", async () => {
  startHub("hub");

  const answer = await ask("/telegram%3A-100%3A5", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: '{"text":"hi","id":"a1"}',
  });

  expect(answer.status).toBe(201);
  expect(answer.headers.get("content-type")).toContain("application/json");
  expect(await answer.json()).toEqual({ from: "hub" });
  expect(asked).toEqual(['hub POST /telegram%3A-100%3A5 Bearer secret {"text":"hi","id":"a1"}']);
});

test("a request that comes while no hub runs waits for the next hub, which answers it", async () => {
  const list = ask("/");
  const sent = ask("/telegram:1", { method: "POST", body: '{"text":"hi","id":"a1"}' });
  await Bun.sleep(100);
  startHub("next");

  expect(await (await list).json()).toEqual({ from: "next" });
  expect((await sent).status).toBe(201);
  expect(asked.toSorted()).toEqual(["next GET /", 'next POST /telegram:1 {"text":"hi","id":"a1"}']);
});

test("a chat's poll the hub dropped as it stopped is answered by the next hub at once, with the chat as it is now", async () => {
  startHub("old", new Promise(() => {}));
  const poll = ask("/telegram:1?after=7");

  while (asked.length === 0) {
    await Bun.sleep(5);
  }

  await stopHub();
  startHub("new");

  expect(await (await poll).json()).toEqual({ from: "new" });
  expect(asked).toEqual(["old GET /telegram:1?after=7", "new GET /telegram:1"]);
});

test("a hub that arrives while nothing waits is found by the next request", async () => {
  startHub("old");
  await stopHub();
  startHub("new");

  expect(await (await ask("/telegram:1?after=7")).json()).toEqual({ from: "new" });
  expect(asked).toEqual(["new GET /telegram:1?after=7"]);
});
