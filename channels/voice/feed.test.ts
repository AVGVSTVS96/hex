import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "@hex/hub";
import type { Check } from "@hex/hub";

import { Board } from "./board.ts";
import type { Finished } from "./board.ts";
import { Feed } from "./feed.ts";
import type { Sources } from "./feed.ts";
import type { DecidedByHex } from "./questions.ts";

const home = mkdtempSync(join(tmpdir(), "voice-feed-"));
const hex = join(home, "hex");
const state = join(hex, "state");
const claude = join(home, "claude");

mkdirSync(join(state, "telegram"), { recursive: true });

mkdirSync(claude, { recursive: true });

const board = new Board(state, hex, claude);
const feeds: Feed[] = [];

afterAll(() => {
  board.close();

  for (const feed of feeds) {
    feed.stop();
  }

  rmSync(home, { recursive: true });
});

const DAY = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function feedOf(sources: Partial<Sources> = {}, at = state) {
  const feed = new Feed(at, {
    closedSince: (since) => board.closedSince(since),
    decided: () => [],
    ...sources,
  });

  feeds.push(feed);
  await feed.check();

  return feed;
}

function emptyState() {
  const at = mkdtempSync(join(home, "state-"));
  open(at);

  return at;
}

async function said(key: string, to: string, body: string, at = state) {
  await open(at).messages.deliver({ key, to, from: "telegram", author: "owner", body });
}

function closedAgo(id: string, days: number) {
  const db = new Database(join(state, "hex.db"));
  const closed = daysAgo(days);
  db.query("update tasks set closed = ? where n = ?").run(closed, Number(id.slice(2)));
  db.close();

  return closed;
}

function checked(at: string, record: Check) {
  appendFileSync(join(at, "ideas.jsonl"), `${JSON.stringify(record)}\n`);
}

function finished(id: number, at: string): Finished {
  return { id: `t-${id}`, title: `Task ${id}`, topic: "hex", app: "telegram", proof: "", at };
}

test("a task closed days ago is done in the feed, opening its task, with its proof's words as the body and its links apart", async () => {
  await open(state).threads.keep("telegram", {
    "-1001234567890:102": { name: "phoneapp", link: "https://t.me/c/1234567890/102" },
  });
  await said("telegram:-1001234567890:9002", "-1001234567890:102", "fix the done tab");
  await said("telegram:-1001234567890:9003", "-1001234567890:102", "the tab is fixed");

  const tab = await open(state).tasks.create({
    title: "Done tab",
    message: "telegram:-1001234567890:9002",
    owner: "-1001234567890:102",
    project: "Phone app",
  });

  await open(state).tasks.edit(tab.id, {
    status: "done",
    proof:
      "https://github.com/x/y/pull/1 · telegram:-1001234567890:9003 (**live** on the phone, build 9)",
  });
  const closed = closedAgo(tab.id, 3);
  await board.refresh();

  expect(board.finished.map((task) => task.id)).not.toContain(tab.id);
  expect((await feedOf()).find(`done:${tab.id}`)).toEqual({
    id: `done:${tab.id}`,
    kind: "done",
    title: "Done tab",
    body: "live on the phone, build 9",
    topic: "Phone app",
    at: closed,
    opens: tab.id,
    links: [
      { label: "github.com/x/y/pull/1", url: "https://github.com/x/y/pull/1" },
      { label: "phoneapp", url: "https://t.me/c/1234567890/102/9003" },
    ],
    pictures: [],
  });
});

test("an idea check that found news is found in the feed, its first sentence the title, and a check that found nothing makes no entry", async () => {
  const at = emptyState();
  await said("telegram:-1001234567890:9100", "-1001234567890:102", "a cloth with MagSafe", at);

  const idea = await open(at).tasks.create({
    title: "A MagSafe polishing cloth",
    message: "telegram:-1001234567890:9100",
    owner: "-1001234567890:102",
    status: "idea",
  });

  checked(at, {
    at: daysAgo(2),
    schedule: "cloth",
    idea: idea.id,
    news: false,
    finding: "Looked at Etsy.",
  });
  checked(at, {
    at: "2026-11-11T18:00:00.008Z",
    schedule: "cloth",
    idea: idea.id,
    news: true,
    finding:
      "Nobody sells one yet. A maker on Etsy does custom cloths, about $20. Links: https://www.etsy.com/listing/1/ · https://example.com/a.",
  });
  checked(at, { at: daysAgo(1), schedule: "cloth", idea: idea.id, error: "timed out" });

  expect((await feedOf({ closedSince: () => Promise.resolve([]) }, at)).entries()).toEqual([
    {
      id: "found:cloth:2026-11-11T18:00:00.008Z",
      kind: "found",
      title: "Nobody sells one yet.",
      body: "A maker on Etsy does custom cloths, about $20.",
      topic: "A MagSafe polishing cloth",
      at: "2026-11-11T18:00:00.008Z",
      opens: idea.id,
      links: [
        { label: "etsy.com/listing/1", url: "https://www.etsy.com/listing/1/" },
        { label: "example.com/a", url: "https://example.com/a" },
      ],
      pictures: [],
    },
  ]);
});

test("what hex decided itself is decided in the feed, its why as the body", async () => {
  const asked = {
    kind: "pick" as const,
    task: "",
    at: daysAgo(2),
    options: [],
    app: "telegram",
    places: [],
  };

  const decided: DecidedByHex[] = [
    {
      ...asked,
      id: "telegram:-1001234567890:5",
      question: "Ship the beta?",
      topic: "phoneapp",
      decided: daysAgo(1),
      why: "It only changes copy. Links: https://example.com/diff",
    },
  ];

  const feed = await feedOf(
    { closedSince: () => Promise.resolve([]), decided: () => decided },
    emptyState(),
  );

  expect(
    feed.entries().map(({ id, kind, title, body, topic, opens, links }) => ({
      id,
      kind,
      title,
      body,
      topic,
      opens,
      links,
    })),
  ).toEqual([
    {
      id: "decided:telegram:-1001234567890:5",
      kind: "decided",
      title: "Ship the beta?",
      body: "It only changes copy.",
      topic: "phoneapp",
      opens: "telegram:-1001234567890:5",
      links: [{ label: "example.com/diff", url: "https://example.com/diff" }],
    },
  ]);
});

test("without before the feed is the last week, or the 30 newest when the week has fewer, newest first", async () => {
  const sparse = Array.from({ length: 50 }, (_, i) => finished(i, daysAgo(i * 0.5 + 0.1)));
  const dense = Array.from({ length: 50 }, (_, i) => finished(i, daysAgo(i * 0.15 + 0.1)));

  const few = (
    await feedOf({ closedSince: () => Promise.resolve(sparse) }, emptyState())
  ).stretch();

  expect(few.entries.map((entry) => entry.opens)).toEqual(
    sparse.slice(0, 30).map((task) => task.id),
  );
  expect(few.older).toBe(Date.parse(sparse[29]?.at ?? ""));

  const many = (
    await feedOf({ closedSince: () => Promise.resolve(dense) }, emptyState())
  ).stretch();

  expect(many.entries.map((entry) => entry.opens)).toEqual(
    dense.filter((task) => task.at >= daysAgo(7)).map((task) => task.id),
  );
  expect(many.entries.length).toBeGreaterThan(30);
});

test("before gives the stretch older than it, and older is 0 once there's nothing older", async () => {
  const tasks = Array.from({ length: 50 }, (_, i) => finished(i, daysAgo(i * 0.5 + 0.1)));
  const feed = await feedOf({ closedSince: () => Promise.resolve(tasks) }, emptyState());

  const next = feed.stretch(Date.parse(tasks[29]?.at ?? ""));
  expect(next.entries.map((entry) => entry.opens)).toEqual(tasks.slice(30).map((task) => task.id));
  expect(next.older).toBe(0);
  expect(feed.stretch(Date.parse(tasks[49]?.at ?? ""))).toEqual({ entries: [], older: 0 });
});

test("the feed's version grows when an entry comes, and only then", async () => {
  const at = emptyState();
  await said("telegram:-1001234567890:9200", "-1001234567890:102", "ship it", at);

  const feed = await feedOf(
    {
      closedSince: async (since) =>
        (await open(at).tasks.finished(since)).map((task) =>
          finished(Number(task.id.slice(2)), task.closed ?? ""),
        ),
    },
    at,
  );

  const before = feed.version;

  await feed.check();
  expect(feed.version).toBe(before);

  const waited = feed.changes(before, 4000);
  checked(at, { at: daysAgo(1), schedule: "cloth", idea: "t-9", news: true, finding: "In stock." });
  await waited;
  expect(feed.version).toBeGreaterThan(before);
  expect(feed.entries().map((entry) => entry.title)).toEqual(["In stock."]);

  const after = feed.version;

  const task = await open(at).tasks.create({
    title: "Ship",
    message: "telegram:-1001234567890:9200",
    owner: "-1001234567890:102",
  });

  await open(at).tasks.edit(task.id, { status: "done", proof: "shipped" });
  await feed.check();
  expect(feed.version).toBeGreaterThan(after);
  expect(feed.entries().map((entry) => entry.opens)).toEqual([task.id, "t-9"]);
});
