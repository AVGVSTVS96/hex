import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { clock } from "./clock.ts";
import {
  fault,
  toldOwner,
  ignoreLost,
  settled,
  heard,
  matching,
  SESSION,
  message,
  dir,
  hub,
  start,
  settles,
  storeCalls,
  storeWaits,
  session,
  registry,
  launched,
  time,
  bgStarts,
} from "./hub.testing.ts";
import { claimedAs, takeOver, whenLost, whenMoved } from "./kept.ts";
import { Ledger } from "./ledger.ts";
import * as stores from "./store.ts";
import { file, LostError, RefusedError } from "./store.ts";
import { hangUpAll } from "./testing.ts";
import { until } from "./until.ts";

const keysKept = () =>
  z
    .array(z.object({ key: z.string() }))
    .parse(file(dir).db.query("select key from messages order by n").all())
    .map(({ key }) => key);

async function onCall() {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });

  return await session("chat:7");
}

test("a message that comes while hex's store can't be reached reaches its session, is never said to be safe until the store has it, and lands once, by its key", async () => {
  const { received } = await onCall();
  fault.outage = "unreached";
  const owed = { ...message, key: "1:60" };

  expect(await hub.deliver("chat:7", "Desk anchors", owed)).toBe(true);
  await until(() => heard(received).some(({ content }) => content === "hi"));
  expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });
  expect(keysKept()).toEqual([]);

  fault.outage = undefined;
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:60"]);

  await hub.deliver("chat:7", "Desk anchors", owed);
  await hub.synced();
  await settled();
  expect(keysKept()).toEqual(["telegram:1:60"]);
  expect(heard(received).filter(({ content }) => content === "hi")).toHaveLength(1);
});

const OperationsKept = z.array(z.object({ id: z.string(), result: z.string().nullable() }));

const operationsKept = () =>
  OperationsKept.parse(file(dir).db.query("select id, result from operations").all());

const asked = (call: string) => storeCalls.filter((name) => name === call).length;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store's calls of one name wait, from now until the function this gives is called.
function holdStore(call: string) {
  const go: (() => void)[] = [];

  storeWaits.set(
    call,
    new Promise<void>((resolve) => {
      go.push(resolve);
    }),
  );

  return () => go.shift()?.();
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session on a hub whose reply tool counts how often it ran, and waits to answer while held is set.
async function replying() {
  const waiting: (() => void)[] = [];
  const told = { ran: 0, held: false };

  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    call: async () => {
      told.ran += 1;
      const mine = told.ran;

      if (told.held) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      }

      return `sent ${mine}`;
    },
  });

  const line = await session("chat:7");

  const reply = async (id: string, text = "still here") =>
    (await line.call("reply", { text }, id)).content[0]?.text;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A repeat has reached the hub once a call made after it under its id is answered, since the hub takes an id's calls in the order they came; while the first still runs, a different one is told so at once.
  const arrived = async (id: string) => {
    expect(await reply(id, "a call made after it")).toContain("identifies a different call");
  };

  return { told, waiting, reply, arrived };
}

test("a tool call made while hex's store can't be reached runs, and runs once however often it's repeated: in the outage, and once the store is back, which then holds its record", async () => {
  const { told, reply } = await replying();
  fault.outage = "unreached";

  expect(await reply("tool-1")).toBe("sent 1");
  expect(await reply("tool-1")).toBe("sent 1");
  expect(operationsKept()).toEqual([]);

  fault.outage = undefined;
  await hub.synced();
  expect(await reply("tool-1")).toBe("sent 1");
  expect(told.ran).toBe(1);
  expect(operationsKept()).toEqual([{ id: matching(/tool-1/u), result: matching(/sent 1/u) }]);
});

test("a tool call whose start the store missed, though it answers again by the call's end, is kept whole, so its repeat doesn't run", async () => {
  const { told, waiting, reply } = await replying();
  told.held = true;
  fault.outage = "unreached";
  const first = reply("tool-2");
  await until(() => waiting.length);
  fault.outage = undefined;
  waiting.shift()?.();

  expect(await first).toBe("sent 1");
  expect(operationsKept()).toEqual([{ id: matching(/tool-2/u), result: matching(/sent 1/u) }]);
  told.held = false;
  expect(await reply("tool-2")).toBe("sent 1");
  expect(told.ran).toBe(1);
});

test("a tool call still running as hex's store stops answering runs once, its repeat joining it: one that began with the store answering, and one that began in an outage the store came back from", async () => {
  const { told, waiting, reply, arrived } = await replying();

  const repeatedInAnOutage = async (id: string) => {
    fault.outage = "unreached";
    told.held = false;
    const again = reply(id);
    await arrived(id);
    waiting.shift()?.();

    return await again;
  };

  told.held = true;
  const first = reply("tool-4");
  await until(() => waiting.length);
  expect(await repeatedInAnOutage("tool-4")).toBe("sent 1");
  expect(await first).toBe("sent 1");

  told.held = true;
  const second = reply("tool-5");
  await until(() => waiting.length);
  fault.outage = undefined;
  await hub.synced();
  expect(await repeatedInAnOutage("tool-5")).toBe("sent 2");
  expect(await second).toBe("sent 2");
  expect(told.ran).toBe(2);
});

test("a repeat that comes while its call's end is on its way to hex's store joins the call, though the store takes the end and then stops answering", async () => {
  const { told, waiting, reply, arrived } = await replying();
  told.held = true;
  const first = reply("tool-7");
  await until(() => waiting.length);

  const finishes = asked("finish");
  const begins = asked("begin");
  const endLands = holdStore("finish");
  told.held = false;
  waiting.shift()?.();
  await until(() => asked("finish") > finishes);

  const beginAnswered = holdStore("begin");
  const again = reply("tool-7");
  await Promise.race([arrived("tool-7"), until(() => asked("begin") > begins)]);
  endLands();
  expect(await first).toBe("sent 1");
  fault.outage = "unreached";
  beginAnswered();

  expect(await again).toBe("sent 1");
  expect(told.ran).toBe(1);
});

test("a different call under the id of one still running is told so, though hex's store can't be asked", async () => {
  const { told, waiting, reply } = await replying();
  told.held = true;
  const first = reply("tool-8");
  await until(() => waiting.length);

  fault.outage = "unreached";
  expect(await reply("tool-8", "something else")).toContain("identifies a different call");
  waiting.shift()?.();

  expect(await first).toBe("sent 1");
  expect(told.ran).toBe(1);
});

test("a tool call's start and its end are one write each to a store that answers", async () => {
  const { reply } = await replying();
  storeCalls.length = 0;

  expect(await reply("tool-6")).toBe("sent 1");
  expect(storeCalls.filter((name) => name === "begin" || name === "finish")).toEqual([
    "begin",
    "finish",
  ]);
});

test("a tool call made in an outage and repeated to the next hub is answered from what the last hub owed, and the store holds its record", async () => {
  const last = await replying();
  fault.outage = "unreached";
  expect(await last.reply("tool-3")).toBe("sent 1");
  await settled();
  hub.close();
  hangUpAll();

  fault.outage = undefined;
  const next = await replying();
  expect(await next.reply("tool-3")).toBe("sent 1");
  expect(next.told.ran).toBe(0);
  await hub.synced();
  expect(operationsKept()).toEqual([{ id: matching(/tool-3/u), result: matching(/sent 1/u) }]);
});

test("a reply the owner got while hex's store can't be reached isn't failed by the questions ledger's note of it, which the store has once it answers, though the hub restarted meanwhile", async () => {
  const ledger = new Ledger(dir, "telegram", (note) => hub.noted(note));

  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    call: async (thread) => {
      await ledger.said(thread, 9, "Tuesday. Is that soon enough?");

      return "sent";
    },
  });

  file(dir).questions.ask({
    asker: "owner",
    app: "telegram",
    thread: "chat:7",
    message: 8,
    text: "When does it ship?",
    options: [],
  });

  const line = await session("chat:7");
  fault.outage = "unreached";
  expect((await line.call("reply", { text: "Tuesday." }, "tool-9")).content[0]?.text).toBe("sent");
  hub.close();
  hangUpAll();

  const restarting = start();
  await Bun.sleep(300);
  fault.outage = undefined;
  await restarting;
  await hub.synced();

  expect(file(dir).questions.get("telegram", "chat:7", 8)?.answer).toMatchObject({
    via: "hex",
    message: 9,
  });
  expect(file(dir).questions.get("telegram", "chat:7", 9)?.text).toBe(
    "Tuesday. Is that soon enough?",
  );
});

test("what the hub owes hex's store lands before what comes after it, and what a session took meanwhile lands as taken", async () => {
  const { send } = await onCall();
  fault.outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:61" });
  await send({
    type: "state",
    thread: "chat:7",
    busy: true,
    taken: ["telegram:1:61"],
    session: SESSION,
  });
  await hub.sent("chat:7", { key: "reply", content: "on it" });

  fault.outage = undefined;
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:62" });
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:61", "telegram:reply", "telegram:1:62"]);
  expect(file(dir).messages.get("telegram:1:61")?.taken?.by).toBe(SESSION);
});

test("a message hex's store keeps, whose session connects while the store can't be reached, is given to that session, ahead of what comes after", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:63" });
  await launched();
  fault.outage = "unreached";
  const { received } = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:64", content: "and then" });
  await until(() => heard(received).some(({ content }) => content === "and then"));
  expect(heard(received).map(({ content }) => content)).toEqual(["hi", "and then"]);
});

test("a message hex's store keeps, waiting on a running session with no channel that ends while the store can't be reached, starts the thread's next session", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:65" });
  await settled();
  fault.outage = "unreached";
  writeFileSync(join(dir, "agents"), "[]");
  await time.lapse(50);
  await settled();
  expect(bgStarts()).toHaveLength(1);
});

test("what a session's hooks couldn't keep while hex's store was unreachable, the hub keeps once it answers", async () => {
  const { send } = await onCall();
  fault.outage = "unreached";

  const typed = {
    key: "terminal:1",
    to: "chat:7",
    from: "terminal",
    author: "owner" as const,
    body: "typed in the terminal",
    meta: { session: SESSION },
  };

  await send({ type: "owed", thread: "chat:7", said: [{ row: typed, by: SESSION }] });
  await settled();
  expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });

  fault.outage = undefined;
  await hub.synced();
  expect(file(dir).messages.get("terminal:1")).toMatchObject({
    body: "typed in the terminal",
    taken: { by: SESSION },
  });
});

test("a hub hex's store refused for an older tenure passes nothing on, says nothing is safe, and stops as one that lost hex", async () => {
  const { received } = await onCall();
  const heardLost: string[] = [];

  const unlisten = whenLost((why) => {
    heardLost.push(why);
  });

  fault.outage = "lost";

  try {
    expect(await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:63" })).toBe(false);

    const synced = await settles(hub.synced());
    expect(synced.status === "rejected" && synced.reason instanceof LostError).toBe(true);
    expect(heardLost[0]).toContain("no longer holds hex");

    fault.outage = undefined;
    expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });
    await settled();
    expect(heard(received).some(({ content }) => content === "hi")).toBe(false);
  } finally {
    unlisten();
  }
});

test("a hub whose store can't be reached as it starts waits for it instead of failing, and starts once it answers", async () => {
  fault.outage = "unreached";
  let started = false;

  const starting = (async () => {
    await start();
    started = true;
  })();

  await Bun.sleep(300);
  expect(started).toBe(false);

  fault.outage = undefined;
  await starting;
  expect(started).toBe(true);
});

test("a message hex's store refuses outright reaches its session, and the store keeps a note of it under its key, so it's settled rather than lost", async () => {
  const { received } = await onCall();
  fault.refusingOver = 300;
  const long = "x".repeat(400);

  expect(
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: long, key: "1:64" }),
  ).toBe(true);
  await until(() => heard(received).some(({ content }) => content === long));
  await hub.synced();
  expect(file(dir).messages.get("telegram:1:64")).toMatchObject({
    body: matching(/^\[hub\] hex's store refused this message/u),
    meta: { refused: "true" },
  });
});

test("a hub whose hex.db moved to a store across the network keeps what it's given there, and restarts on it", async () => {
  const { received } = await onCall();
  const object = mkdtempSync(join(tmpdir(), "object-"));
  let heardMoved = 0;

  const unlisten = whenMoved(() => {
    heardMoved++;
  });

  try {
    fault.movedTo = object;
    fault.outage = "moved";
    await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:65" });
    await until(() => heard(received).some(({ content }) => content === "hi"));
    expect(heardMoved).toBeGreaterThan(0);

    await hub.synced();
    expect(file(object).messages.get("telegram:1:65")?.body).toBe("hi");
    expect(keysKept()).toEqual([]);
  } finally {
    unlisten();
    rmSync(object, { recursive: true, force: true });
  }
});

test("a thread opened or changed while hex's store can't take anything is saved once it can", async () => {
  await onCall();
  fault.outage = "unreached";
  hub.register("chat:9", "New topic");
  hub.configure("chat:7", { model: "sonnet" });
  await settled();

  fault.outage = undefined;
  await hub.synced();
  expect(registry()).toMatchObject({
    "chat:7": { name: "Desk anchors", model: "sonnet" },
    "chat:9": { name: "New topic" },
  });
});

test("what the hub kept after an outage carries the time it was given, so the turn's memory pass sees it", async () => {
  const { send } = await onCall();
  fault.outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:66" });
  await send({
    type: "state",
    thread: "chat:7",
    busy: true,
    taken: ["telegram:1:66"],
    session: SESSION,
  });
  await settled();
  const turnEnded = new Date().toISOString();
  await Bun.sleep(20);

  fault.outage = undefined;
  await hub.synced();
  expect(
    file(dir)
      .messages.observe(SESSION, turnEnded, "chat:7")
      .map(({ key }) => key),
  ).toEqual(["telegram:1:66"]);
});

test("what the hub owes hex's store outlives a restart during the outage, so hex's replies and what it was given aren't lost", async () => {
  await onCall();
  fault.outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:67" });
  await hub.sent("chat:7", { key: "reply-67", content: "on it" });
  await settled();
  hub.close();
  hangUpAll();

  fault.outage = undefined;
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:67", "telegram:reply-67"]);
});

test("the owner's words held for a turn that ends while hex's store can't take anything go on as it ends, before newer words, and only once", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "held",
    meta: {},
    key: "1:68",
  });
  await settled();
  expect(heard(received)).toEqual([]);

  fault.outage = "unreached";
  await send({ type: "state", thread: "chat:7", busy: false });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "newer",
    meta: {},
    key: "1:69",
  });
  await until(() => received.length === 2);
  expect(heard(received).map((turn) => turn.content)).toEqual(["held", "newer"]);

  fault.outage = undefined;
  await hub.synced();
  await settled();
  expect(heard(received).map((turn) => turn.content)).toEqual(["held", "newer"]);
  expect(file(dir).messages.get("telegram:1:68")?.body).toBe("held");
});

test("a message too long for hex's store keeps as much of it as the store takes, under its key", async () => {
  const { received } = await onCall();
  fault.refusingOver = 7_500_000;
  const long = "x".repeat(8_000_000);

  await hub.deliver("chat:7", "Desk anchors", { ...message, content: long, key: "1:70" });
  await until(() => heard(received).some(({ content }) => content?.length === long.length));
  await hub.synced();

  const kept = file(dir).messages.get("telegram:1:70");
  expect(kept?.meta?.refused).toBe("cut");
  expect(kept?.body.startsWith("x".repeat(7_000_000))).toBe(true);
  expect(kept?.body).toContain("so it keeps only the part above");
});

test("a hub restarted while hex's store can't take anything keeps the thread changes it owed, rather than the store's older ones", async () => {
  await onCall();
  fault.outage = "unreached";
  hub.register("chat:9", "New topic");
  hub.configure("chat:7", { model: "sonnet" });
  await settled();
  hub.close();
  hangUpAll();

  const restarting = start();
  await Bun.sleep(300);
  fault.outage = undefined;
  await restarting;
  await hub.synced();
  await settled();
  expect(registry()).toMatchObject({
    "chat:7": { name: "Desk anchors", model: "sonnet" },
    "chat:9": { name: "New topic" },
  });
});

test("a hub whose spool can't be written goes on from memory, so a full disk never leaves hex deaf", async () => {
  const { received } = await onCall();
  mkdirSync(join(dir, "owed.telegram.json.next"));
  fault.outage = "unreached";

  expect(await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:71" })).toBe(true);
  await until(() => heard(received).some(({ content }) => content === "hi"));
  expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });

  fault.outage = undefined;
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:71"]);
});

test("a turn's last words a hook handed the hub during an outage keep the time it said them, so the turn's memory pass sees them", async () => {
  const { send } = await onCall();
  fault.outage = "unreached";
  const spokeAt = new Date().toISOString();
  await Bun.sleep(5);
  const turnEnded = new Date().toISOString();

  const words = {
    key: "terminal:2",
    to: "chat:7",
    from: "terminal",
    author: "hex" as const,
    body: "Done.",
    meta: { session: SESSION },
    at: spokeAt,
  };

  await send({ type: "owed", thread: "chat:7", said: [{ row: words, by: SESSION }] });
  await settled();
  await Bun.sleep(20);

  fault.outage = undefined;
  await hub.synced();
  expect(
    file(dir)
      .messages.observe(SESSION, turnEnded, "chat:7")
      .map(({ key }) => key),
  ).toEqual(["terminal:2"]);
});

test("a hub that learns another machine holds hex still lands what it owed as fact, through a client that never claimed, and lets go of its own state", async () => {
  await onCall();
  fault.outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:80" });
  await hub.sent("chat:7", { key: "reply-80", content: "on it" });
  hub.register("chat:9", "New topic");
  await settled();

  const unlisten = whenLost(ignoreLost);
  fault.outage = "lost";

  try {
    const synced = await settles(hub.synced());
    expect(synced.status === "rejected" && synced.reason instanceof LostError).toBe(true);
    expect(keysKept()).toEqual(["telegram:1:80", "telegram:reply-80"]);
    expect(registry()["chat:9"]).toBeUndefined();
    expect(existsSync(join(dir, "owed.telegram.json"))).toBe(false);
  } finally {
    unlisten();
  }
});

test("what a hub owed from before another hub held hex keeps its facts and lets go of its old threads", async () => {
  await onCall();
  claimedAs(4);
  fault.outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:81" });
  hub.register("chat:9", "Old topic");
  await settled();
  hub.close();
  hangUpAll();

  fault.outage = undefined;
  file(dir).threads.keep("telegram", { "chat:7": { name: "Desk anchors", session: "newer" } });
  claimedAs(9);
  await start();
  await hub.synced();
  await settled();
  expect(keysKept()).toContain("telegram:1:81");
  expect(registry()).toEqual({ "chat:7": { name: "Desk anchors", session: "newer" } });
});

test("a message hex's store refuses for what's in it is set aside whole, what comes after it lands, the owner hears which once, and it lands at a start once the store takes it", async () => {
  const { received } = await onCall();
  fault.refusingKey = "telegram:1:82";

  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:82" });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again", key: "1:83" });
  await until(() => heard(received).some(({ content }) => content === "hi"));
  await hub.synced();
  expect(keysKept()).toEqual([matching(/^hub:refused:/u), "telegram:1:83"]);
  expect(toldOwner).toHaveLength(1);
  expect(toldOwner[0]).toContain("telegram:1:82");
  expect(toldOwner[0]).toContain("tries them again each time it starts");
  expect(toldOwner[0]).toContain("delete one's line there to give up on it");

  hub.close();
  hangUpAll();
  await start();
  await hub.synced();
  expect(toldOwner).toHaveLength(1);

  hub.close();
  hangUpAll();
  fault.refusingKey = undefined;
  await start();
  await hub.synced();
  expect(keysKept()).toContain("telegram:1:82");
  expect(existsSync(join(dir, "refused.telegram.json"))).toBe(false);
});

test("a hub whose hex.db lacks a table this hex's code names fails to start rather than waiting, so bin/hex rolls the update back", async () => {
  file(dir);
  const db = new Database(join(dir, "hex.db"));
  db.run("ALTER TABLE threads RENAME TO threads_gone");
  db.close();

  const started = await settles(start());
  expect(started.status === "rejected" && started.reason instanceof RefusedError).toBe(true);
});

test("a hub that waits a while for its store as it starts tells the owner", async () => {
  fault.outage = "unreached";
  const starting = start({ tellAfter: 0 });
  await until(() => toldOwner.some((told) => told.startsWith("can't start")));

  fault.outage = undefined;
  await starting;
});

test("a file hex restarted while its disk can't take anything keeps the thread changes it owed, through the claim a hub makes as it takes hex over", async () => {
  await takeOver(stores.open(dir));
  await onCall();
  fault.outage = "unreached";
  hub.register("chat:9", "New topic");
  await settled();
  hub.close();
  hangUpAll();

  fault.outage = undefined;
  await takeOver(stores.open(dir));
  await start();
  await hub.synced();
  expect(registry()["chat:9"]).toMatchObject({ name: "New topic" });
});

test("a spool the hex before this one wrote, as one list, is still paid", async () => {
  writeFileSync(
    join(dir, "owed.telegram.json"),
    JSON.stringify([
      {
        kind: "deliver",
        row: { key: "telegram:1:88", to: "chat:7", from: "telegram", author: "owner", body: "hi" },
      },
    ]),
  );

  await start();
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:88"]);
});

test("the owner's words a hook took for the session without the session hearing them go to it from memory as the turn ends", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "held",
    meta: {},
    key: "1:84",
  });
  await settled();
  file(dir).messages.takeHeld("chat:7", SESSION);

  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => received.length);
  await settled();
  expect(heard(received).map((turn) => turn.content)).toEqual(["held"]);
});

test("a hub's spool gains a line for each write it owes rather than being written whole each time", async () => {
  await onCall();
  fault.outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:85" });
  const spool = join(dir, "owed.telegram.json");
  const { ino } = statSync(spool);
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:86" });
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:87" });
  await settled();

  expect(statSync(spool).ino).toBe(ino);
  expect(readFileSync(spool, "utf-8").trim().split("\n")).toHaveLength(3);
});
