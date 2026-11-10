import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { open } from "@hex/hub";
import type { Pin, Question, NewRow } from "@hex/hub";
import { until } from "@hex/hub/testing";
import { z } from "zod";

import { before, digest, failed, vet } from "./check.ts";
import { Questions, fromLedger } from "./questions.ts";
import type { Curated, Source } from "./questions.ts";
import { T3 } from "./t3.ts";

const GROUP = "-1001234";
const DESK = `${GROUP}:5`;
let state: string;
const HubLineSchema = z.looseObject({ type: z.string() });

let questions: Questions;
let hub: Server;
let lines: z.infer<typeof HubLineSchema>[];
let checks: string[];

function parseLines(chunk: string) {
  return chunk
    .trim()
    .split("\n")
    .map((line) => HubLineSchema.parse(JSON.parse(line)));
}

function listed(id: string) {
  const question = questions.find(id);

  return question !== undefined;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected it to be refused");
}

function savedMarks() {
  return z
    .object({
      answers: z.record(z.string(), z.looseObject({})),
      read: z.record(z.string(), z.string()),
      dismissed: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(readFileSync(join(state, "voice", "marks.json"), "utf-8")));
}

function ledger(
  kept: (Omit<Question, "app"> & Partial<Pick<Question, "app">>)[],
  pins: Record<string, Omit<Pin, "app" | "thread" | "note"> & { note?: string }> = {},
) {
  const store = open(state);
  store.write(() => {
    store.db.run("delete from questions");
    store.db.run("delete from pins");

    for (const question of kept) {
      store.questions.ask({ app: "telegram", ...question });
    }

    for (const [thread, pin] of Object.entries(pins)) {
      store.pins.pinned({ app: "telegram", thread, note: pin.text, ...pin });
    }
  });
}

function asked(message: number, text: string, options: string[], fields: Partial<Question> = {}) {
  return {
    app: "telegram",
    thread: DESK,
    message,
    text,
    options,
    at: `2026-10-13T1${message % 10}:00:00.000Z`,
    ...fields,
  };
}

beforeEach(async () => {
  state = mkdtempSync(join(tmpdir(), "questions-"));
  mkdirSync(join(state, "telegram"));
  mkdirSync(join(state, "voice"));
  open(state).threads.keep("telegram", {
    [GROUP]: { name: "hex", link: "https://t.me/c/1234/1" },
    [DESK]: { name: "desk", link: "https://t.me/c/1234/5" },
  });
  lines = [];
  checks = [];
  hub = createServer((socket) => {
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      lines.push(...parseLines(chunk));
    });
  });
  await new Promise<void>((resolve) => {
    hub.listen(join(state, "telegram", "hub.sock"), resolve);
  });
});

afterEach(() => {
  questions?.close();
  hub.close();
  rmSync(state, { recursive: true, force: true });
});

test("a question asked with buttons reads as its first line, its context and the pick its thread marked", () => {
  const question = fromLedger(
    "telegram",
    asked(1, "**Music for the Saves video?**\n\nThree new takes, no cost.\n```\nA  Deep\n```", [
      "Deep (my pick)",
      "French touch",
      "Minimal",
    ]),
  );

  expect(question).toMatchObject({
    id: `telegram:${DESK}:1`,
    kind: "pick",
    task: `telegram:${DESK}`,
    question: "Music for the Saves video?",
    context: "Three new takes, no cost.",
    options: [
      { label: "Deep", value: "Deep (my pick)", pick: true },
      { label: "French touch", value: "French touch" },
      { label: "Minimal", value: "Minimal" },
    ],
  });
});

test("a question keeps all of its context, line by line, so the app can open the rest", () => {
  const context = `- A: ${"what it costs. ".repeat(20).trim()}\n- B: what it takes away.`;
  expect(fromLedger("telegram", asked(1, `Ship it?\n${context}`, ["Yes", "No"])).context).toBe(
    context,
  );
});

test("a long first line ends at its question, and the rest opens its context whole", () => {
  const first =
    "The line graphic next to each project in Tasks (you picked it Oct 15/18) has been deleted since you underlined it. What did you mean? My pick: bring it back, drawn cleanly.";

  const question = fromLedger("telegram", asked(1, `${first}\nMore.`, ["A", "B"]));
  expect(question.question).toBe(
    "The line graphic next to each project in Tasks (you picked it Oct 15/18) has been deleted since you underlined it. What did you mean?",
  );
  expect(question.context).toBe("My pick: bring it back, drawn cleanly.\nMore.");
});

test("a long first line ends at its last question, however short", () => {
  const question = fromLedger(
    "telegram",
    asked(
      1,
      `Should we ship tonight? ${"The redesign brings a calmer palette and bigger type. ".repeat(3).trim()}`,
      ["Yes", "No"],
    ),
  );

  expect(question.question).toBe("Should we ship tonight?");
  expect(question.context?.startsWith("The redesign")).toBe(true);
});

test("a long first line never ends inside brackets, and a long question stays whole", () => {
  const pick = fromLedger(
    "telegram",
    asked(
      1,
      "site next step: a 3D laptop in the hero that opens on its real hinge, plus buttons drawn as keycaps? (hex's pick: Yes. It shows off the laptop and the keyboard with zero words)",
      ["Yes", "No"],
    ),
  );

  expect(pick.question).toBe(
    "site next step: a 3D laptop in the hero that opens on its real hinge, plus buttons drawn as keycaps?",
  );
  expect(pick.context).toBe(
    "(hex's pick: Yes. It shows off the laptop and the keyboard with zero words)",
  );
  const long = `Keep the calmer palette (the one you saw? the blue one) and ${"the bigger type everywhere it shows, ".repeat(4)}tonight? Yes.`;
  const question = fromLedger("telegram", asked(1, long, ["Yes", "No"]));
  expect(question.question).toBe(long.slice(0, -5));
  expect(question.context).toBe("Yes.");
});

test("a long first line with no question mark stays whole as the question", () => {
  const tail =
    "and here the line keeps going well past the limit with plenty of words to spare for the cut";

  for (const first of [
    `Which way ${"one option costs this and the other takes that away ".repeat(4).trim()}`,
    `Ship the redesign with the calmer palette and the bigger type, e.g. Inter at sixteen points ${tail}`,
    `Ok. Ship the redesign with the calmer palette and the bigger type and the new spacing ${tail}`,
    `The redesign has a calmer palette and bigger type. ${"It also changes the spacing everywhere. ".repeat(2)}Ship it tonight ${tail}?`,
  ]) {
    const question = fromLedger("telegram", asked(1, `${first}\nMore.`, ["A", "B"]));
    expect(question.question).toBe(first);
    expect(question.context).toBe("More.");
  }
});

test("a short first line that ends in an ellipsis keeps no context of its own", () => {
  expect(fromLedger("telegram", asked(1, "Ship it…", ["Yes", "No"])).context).toBeUndefined();
});

type Said = [
  timeOnOct13: string,
  body: string,
  fields?: Partial<{
    id: number;
    author: "hex" | "owner";
    to: string;
    meta: Record<string, string>;
  }>,
];

function chatKey(n: number, id?: number) {
  return `telegram:${GROUP}:${id ?? 100 + n}`;
}

function said(rows: Said[]) {
  open(state).messages.past(
    rows.map(([time, body, fields = {}], n): [NewRow, string] => [
      {
        key: chatKey(n, fields.id),
        to: fields.to ?? DESK,
        from: "telegram",
        author: fields.author ?? "hex",
        body,
        ...(fields.meta && { meta: fields.meta }),
      },
      `2026-10-13T${time}.000Z`,
    ]),
    "session",
  );
}

test("a question comes with hex's last two messages in the hour before it in its thread, and only what the owner read there as hex's explanation", () => {
  said([
    ["16:59:00", "Too old."],
    ["18:01:00", "Old news."],
    ["18:02:00", "Caddy gives a short domain.", { id: 50 }],
    ["18:03:00", "which one?", { author: "owner" }],
    ["18:04:00", "(file: plan.png)", { meta: { file: "plan.png" } }],
    ["18:04:30", "The plan, A on the left.", { meta: { file: "plan.png" } }],
    [
      "18:05:00",
      "Caddy gives a short domain, Tailscale none.",
      { meta: { edited: "true", message_id: "50" } },
    ],
    ["18:06:00", "Elsewhere.", { to: GROUP }],
    ["18:07:00", "🔐 Bash: rm -rf build", { meta: { permission: "p1" } }],
    ["18:08:00", "Forwarded words.", { meta: { forwarded: "true" } }],
    ["18:09:00", "Pages\n\n**🔴 Blocked on you**\n- Ship it?"],
    ["18:10:00", "Ship it?", { id: 8 }],
    ["18:59:58", "**Which one serves the pages?**"],
    ["18:59:59", "A or B", { id: 9 }],
  ]);
  ledger([asked(8, "Ship it?", ["Yes", "No"])]);

  const question = asked(9, "**Which one serves the pages?**\nA or B", ["Caddy", "Tailscale"], {
    at: "2026-10-13T19:00:00.000Z",
  });

  expect(before(open(state), "telegram", question)).toEqual([
    "Caddy gives a short domain.",
    "The plan, A on the left.",
  ]);
  expect(before(open(state), "telegram", question, 10)).toEqual(["Caddy giv…", "The plan,…"]);
  expect(before(open(state), "telegram", { ...question, at: "2026-10-13T18:01:30.000Z" })).toEqual([
    "Old news.",
  ]);
});

test("a question asked in General or a DM comes with none of hex's messages before it, which are about any project, and its ask's words are its own message, under its thread's project, and a note on it goes where it was asked", async () => {
  const DM = "6001";
  open(state).threads.keep("telegram", {
    [GROUP]: { name: "hex" },
    [DESK]: { name: "desk" },
    [DM]: { name: "DM" },
  });
  said([
    ["18:20:00", "Your call failed: OpenAI is out of credit.", { to: GROUP }],
    ["18:30:00", "notes: Logseq names no writer device.", { to: GROUP }],
    ["18:40:00", "Rivals is done: all three products compared.", { to: DM }],
  ]);

  const name = asked(9, "For Stripe Atlas: Lantern or Miyage?", ["Lantern", "Miyage"], {
    thread: GROUP,
    at: "2026-10-13T19:00:00.000Z",
  });

  const row = asked(8, "Portfolio: add the panel row?", ["Add it", "Skip"], {
    thread: DM,
    at: "2026-10-13T19:00:00.000Z",
  });

  expect(before(open(state), "telegram", name)).toEqual([]);
  expect(before(open(state), "telegram", row)).toEqual([]);
  ledger([name, row]);
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T20:00:00.000Z",
      why: "test",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:panel-row",
          kind: "yesno",
          task: `telegram:${DESK}`,
          at: "2026-10-13T19:00:00.000Z",
          question: "Portfolio: add the panel row?",
          options: [{ label: "Add it" }, { label: "Skip" }],
          from: [{ app: "telegram", thread: DM, message: 8 }],
          refs: [{ app: "telegram", thread: DM, message: 8 }],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(questions.find("check:panel-row")).toMatchObject({
    topic: "desk",
    places: [{ place: "DM" }],
  });
  open(state).threads.file(DESK, "portfolio");
  await until(() => questions.find("check:panel-row")?.topic === "portfolio");
  expect(questions.words("check:panel-row")).toEqual({
    place: "DM",
    at: "2026-10-13T19:00:00.000Z",
    text: "Portfolio: add the panel row?",
  });
  expect(questions.words(`telegram:${GROUP}:9`)).toBeUndefined();
  expect(await questions.note("check:panel-row", "which row?", "app")).toEqual({
    thread: `telegram:${DM}`,
    topic: "DM",
    settled: 0,
    missed: 0,
  });
  await until(() => lines.length === 1);
  expect(lines[0]).toMatchObject({ type: "inbound", thread: DM });
});

test("a question the check hasn't rewritten yet keeps its own words on the card and hex's messages before it, whole, as its words", () => {
  said([
    ["18:20:00", "Caddy gives a short domain."],
    ["18:30:00", `**Caddy** needs a server. ${"More. ".repeat(150).trim()}`],
  ]);
  ledger([
    asked(9, "Caddy or Tailscale?\nCaddy is mine.", ["Caddy", "Tailscale"], {
      at: "2026-10-13T19:00:00.000Z",
    }),
    asked(8, "Ship it?", ["Yes", "No"]),
  ]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(questions.find(`telegram:${DESK}:9`)?.context).toBe("Caddy is mine.");
  expect(questions.words(`telegram:${DESK}:9`)).toEqual({
    place: "desk",
    at: "2026-10-13T19:00:00.000Z",
    text: `Caddy gives a short domain.\n\n**Caddy** needs a server. ${"More. ".repeat(150).trim()}`,
  });
  expect(questions.words(`telegram:${DESK}:8`)).toBeUndefined();
  expect(questions.words("check:gone")).toBeUndefined();
});

test("the check's asks read their words from their first place that has them: a question, a plain message, a pinned post or a call", () => {
  const calls = join(state, "calls");
  mkdirSync(calls);
  writeFileSync(
    join(calls, "live_1.json"),
    JSON.stringify({
      id: "live_1",
      title: "Morning call",
      started: "2026-10-13T08:00:00.000Z",
      ended: "2026-10-13T08:05:00.000Z",
      summary: "They want the laptop tonight.",
    }),
  );
  said([
    ["18:20:00", "Caddy gives a short domain."],
    ["18:25:00", "Which one serves the pages?", { id: 70 }],
  ]);
  ledger(
    [asked(9, "Caddy or Tailscale?", ["Caddy", "Tailscale"], { at: "2026-10-13T19:00:00.000Z" })],
    {
      [GROUP]: {
        message: 40,
        text: "Pages",
        at: "2026-10-13T10:00:00.000Z",
        note: "Pages live.\n\nOn you:\n• Pick a host",
      },
      [DESK]: {
        message: 41,
        text: "Desk",
        at: "2026-10-13T10:00:00.000Z",
        note: "Desk: the help site.\n\n1. ✓ Ship it\n2. Docs",
      },
    },
  );

  const ask = (id: string, from: Source[]) => ({
    id,
    kind: "pick",
    task: `telegram:${DESK}`,
    at: "2026-10-13T00:00:00.000Z",
    question: id,
    options: [{ label: "Ok" }],
    from,
  });

  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T20:00:00.000Z",
      why: "test",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        ask("check:question", [
          { app: "telegram", thread: DESK },
          { app: "telegram", thread: DESK, message: 404 },
          { app: "telegram", thread: DESK, message: 9 },
        ]),
        ask("check:message", [{ app: "telegram", thread: DESK, message: 70 }]),
        ask("check:pin", [{ app: "telegram", thread: GROUP, message: 40 }]),
        ask("check:plan", [{ app: "telegram", thread: DESK, message: 41 }]),
        ask("check:call", [{ app: "voice", call: "live_1" }]),
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    calls,
    check: (why) => {
      checks.push(why);
    },
  });
  expect(questions.words("check:question")).toEqual({
    place: "desk",
    at: "2026-10-13T19:00:00.000Z",
    text: "Caddy gives a short domain.\n\nWhich one serves the pages?\n\nCaddy or Tailscale?",
  });
  expect(questions.words("check:message")).toEqual({
    place: "desk",
    at: "2026-10-13T18:25:00.000Z",
    text: "Caddy gives a short domain.\n\nWhich one serves the pages?",
  });
  expect(questions.words("check:pin")).toEqual({
    place: "General",
    at: "2026-10-13T10:00:00.000Z",
    text: "On you:\n• Pick a host",
  });
  expect(questions.words("check:plan")).toEqual({
    place: "desk",
    at: "2026-10-13T10:00:00.000Z",
    text: "Desk: the help site.",
  });
  expect(questions.words("check:call")).toEqual({
    place: "Morning call",
    at: "2026-10-13T08:05:00.000Z",
    text: "They want the laptop tonight.",
  });
});

test("open questions come newest first with a link to each, answered and settled ones drop out", () => {
  ledger([
    asked(1, "Ship it?", ["Yes", "No"]),
    asked(2, "Rename it?", ["Yes", "No"], { answer: { label: "No", at: "", via: "telegram" } }),
    asked(3, "Which color?", ["Mint", "Coral"]),
  ]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(
    questions.view.asks.map((question) => [
      question.question,
      question.app,
      question.topic,
      question.places,
    ]),
  ).toEqual([
    [
      "Which color?",
      "telegram",
      "desk",
      [
        {
          app: "telegram",
          place: "desk",
          task: `telegram:${DESK}`,
          link: "https://t.me/c/1234/5/3",
        },
      ],
    ],
    [
      "Ship it?",
      "telegram",
      "desk",
      [
        {
          app: "telegram",
          place: "desk",
          task: `telegram:${DESK}`,
          link: "https://t.me/c/1234/5/1",
        },
      ],
    ],
  ]);
});

test("General's questions sit under General, the name its places and its run go by, not the name hex.db keeps", () => {
  ledger([
    {
      thread: GROUP,
      message: 7,
      text: "Ship it?",
      options: ["Yes", "No"],
      at: "2026-10-13T12:00:00.000Z",
    },
  ]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(
    questions.view.asks.map((question) => [
      question.topic,
      question.places.map((place) => place.place),
    ]),
  ).toEqual([["General", ["General"]]]);
});

test("the check’s version of a question stands in for every place that asked it, and newer questions lead", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    asked(2, "Upgrade Twilio now?", ["Go", "Wait"]),
    asked(9, "Brand new?", ["Yes", "No"]),
  ]);
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T15:00:00.000Z",
      why: "a pinned post changed",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:twilio",
          kind: "do",
          task: `telegram:${DESK}`,
          at: "2026-10-11T00:00:00.000Z",
          question: "Upgrade Twilio from trial",
          options: [
            { label: "Upgrade", value: "Upgrade", pick: true },
            { label: "Use the app", value: "Not yet" },
          ],
          tag: "unblocks 3",
          refs: [
            { app: "telegram", thread: DESK, message: 1 },
            { app: "telegram", thread: DESK, message: 2 },
          ],
        },
        {
          id: "check:read",
          kind: "look",
          task: `telegram:${DESK}`,
          at: "2026-10-13T00:00:00.000Z",
          question: "Read the launch review",
          options: [{ label: "Open" }],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(questions.view.asks.map((question) => question.id)).toEqual([
    `telegram:${DESK}:9`,
    "check:twilio",
    "check:read",
  ]);
  expect(questions.view.asks.map((question) => question.app)).toEqual([
    "telegram",
    "telegram",
    "telegram",
  ]);
  expect(questions.view.check).toEqual({
    at: "2026-10-13T15:00:00.000Z",
    why: "a pinned post changed",
    fixed: 0,
    flagged: 0,
  });

  expect(await questions.answer("check:twilio", "Use the app", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 2,
    missed: 0,
  });
  await until(() => lines.length === 2);
  expect(lines).toEqual([
    { type: "answer", thread: DESK, message: 1, label: "Not yet", via: "app" },
    { type: "settle", thread: DESK, message: 2, note: "✓ Answered in the app: Use the app" },
  ]);

  expect(await questions.answer("check:read", "Open", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 0,
    missed: 0,
  });
  expect(await until(() => lines.find((line) => line.type === "inbound"))).toEqual({
    type: "inbound",
    thread: DESK,
    content: "(answered in the app) Read the launch review: Open",
    author: "owner",
    meta: { user: "hex app" },
  });
  await until(() => !listed("check:read"));
  await questions.undo("check:read", "app");
  await until(() => questions.find("check:read"));
  expect(checks).toContain("you took back an answer");
});

test("an answer that lands in the ledger takes the question off the list, and undo asks for its buttons back", async () => {
  ledger([asked(1, "Ship it?", ["Yes", "No"])]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  const version = questions.version;
  await questions.answer(`telegram:${DESK}:1`, "Yes", "app");
  expect(await until(() => lines[0])).toEqual({
    type: "answer",
    thread: DESK,
    message: 1,
    label: "Yes",
    via: "app",
  });
  ledger([asked(1, "Ship it?", ["Yes", "No"], { answer: { label: "Yes", at: "", via: "app" } })]);
  await questions.changes(version, 2000);
  expect(questions.view.asks).toEqual([]);
  await questions.undo(`telegram:${DESK}:1`, "app");
  expect(await until(() => lines[1])).toEqual({
    type: "reopen",
    thread: DESK,
    message: 1,
    via: "app",
  });
});

test("a note reaches the thread that asked and leaves the question open, with nothing settled", async () => {
  ledger([asked(1, "Ship it?", ["Yes", "No"])]);
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "",
      why: "",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:read",
          kind: "look",
          task: `telegram:${DESK}`,
          at: "",
          question: "Read the review",
          options: [{ label: "Open" }],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(
    await questions.note(`telegram:${DESK}:1`, "i wish i could get more context", "app"),
  ).toEqual({ thread: `telegram:${DESK}`, topic: "desk", settled: 0, missed: 0 });
  await questions.note("check:read", "which one?", "app");
  await until(() => lines.length === 2);
  expect(lines).toEqual([
    {
      type: "inbound",
      thread: DESK,
      content: "(note written in the app) Ship it?: i wish i could get more context",
      author: "owner",
      meta: { user: "hex app" },
    },
    {
      type: "inbound",
      thread: DESK,
      content: "(note written in the app) Read the review: which one?",
      author: "owner",
      meta: { user: "hex app" },
    },
  ]);
  await Bun.sleep(60);
  expect(questions.view.asks.map((question) => question.id)).toEqual([
    `telegram:${DESK}:1`,
    "check:read",
  ]);
});

test("not needed takes a question off the list, settles its copies and tells its thread, and undo brings it back", async () => {
  ledger([asked(1, "Ship it?", ["Yes", "No"])]);
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "",
      why: "",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:read",
          kind: "look",
          task: `telegram:${DESK}`,
          at: "",
          question: "Read the review",
          options: [{ label: "Open" }],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(await questions.dismiss(`telegram:${DESK}:1`, "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 1,
    missed: 0,
  });
  await until(() => lines.length === 2);
  expect(lines).toEqual([
    {
      type: "inbound",
      thread: DESK,
      content: "(not needed, said in the app) Ship it?",
      author: "owner",
      meta: { user: "hex app" },
    },
    { type: "settle", thread: DESK, message: 1, note: "✓ Not needed, said in the app" },
  ]);
  expect(await rejection(questions.dismiss(`telegram:${DESK}:1`, "app"))).toContain(
    "already answered or settled",
  );
  expect(await rejection(questions.answer(`telegram:${DESK}:1`, "Yes", "app"))).toContain(
    "already answered or settled",
  );
  ledger([
    asked(1, "Ship it?", ["Yes", "No"], {
      settled: { note: "✓ Not needed, said in the app", at: "" },
    }),
  ]);
  await until(() => questions.view.asks.length === 1);
  await questions.undo(`telegram:${DESK}:1`, "app");
  await until(() => lines.length === 4);
  expect(lines.slice(2)).toEqual([
    { type: "reopen", thread: DESK, message: 1, via: "app" },
    {
      type: "inbound",
      thread: DESK,
      content: "(took back) Ship it?: Not needed",
      author: "owner",
      meta: { user: "hex app" },
    },
  ]);

  lines = [];
  expect(await questions.dismiss("check:read", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 0,
    missed: 0,
  });
  await until(() => !listed("check:read"));
  await questions.undo("check:read", "app");
  await until(() => questions.find("check:read"));
  expect(lines.map((line) => line.content)).toEqual([
    "(not needed, said in the app) Read the review",
    "(took back) Read the review: Not needed",
  ]);
  expect(await rejection(questions.undo("check:read", "app"))).toContain(
    "there is no answer here to take back",
  );
});

test("an answer its buttons can’t take settles every copy, and undo reopens them and tells the thread it no longer stands, even right away", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    asked(2, "Upgrade Twilio now?", ["Go", "Wait"]),
  ]);
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "",
      why: "",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:twilio",
          kind: "do",
          task: `telegram:${DESK}`,
          at: "",
          question: "Upgrade Twilio",
          options: [{ label: "Upgrade" }],
          refs: [
            { app: "telegram", thread: DESK, message: 1 },
            { app: "telegram", thread: DESK, message: 2 },
          ],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(await questions.answer("check:twilio", "after the launch", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 2,
    missed: 0,
  });
  await questions.undo("check:twilio", "app");
  await until(() => lines.length === 6);
  expect(lines).toEqual([
    {
      type: "inbound",
      thread: DESK,
      content: "(answered in the app) Upgrade Twilio: after the launch",
      author: "owner",
      meta: { user: "hex app" },
    },
    { type: "settle", thread: DESK, message: 1, note: "✓ Answered in the app: after the launch" },
    { type: "settle", thread: DESK, message: 2, note: "✓ Answered in the app: after the launch" },
    { type: "reopen", thread: DESK, message: 1, via: "app" },
    { type: "reopen", thread: DESK, message: 2, via: "app" },
    {
      type: "inbound",
      thread: DESK,
      content: "(took back) Upgrade Twilio: after the launch",
      author: "owner",
      meta: { user: "hex app" },
    },
  ]);
});

const TWILIO = {
  id: "check:twilio",
  kind: "do",
  task: `telegram:${DESK}`,
  at: "",
  question: "Upgrade Twilio",
  options: [
    { label: "Upgrade", value: "Upgrade" },
    { label: "Not yet", value: "Not yet" },
  ],
  refs: [
    { app: "telegram", thread: DESK, message: 1 },
    { app: "discord", thread: DESK, message: 2 },
  ],
};

const TWO_HUBS = { at: "", why: "", read: {}, fixed: [], flagged: [], stuck: [], asks: [TWILIO] };

async function discordHub() {
  mkdirSync(join(state, "discord"), { recursive: true });
  const heard: z.infer<typeof HubLineSchema>[] = [];

  const server = createServer((socket) => {
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      heard.push(...parseLines(chunk));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(join(state, "discord", "hub.sock"), resolve);
  });

  return {
    heard,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(join(state, "discord", "hub.sock"), { force: true });
          resolve();
        });
      }),
  };
}

test("a not needed with one hub down still reaches the rest and says what it missed, and the copy left open can be settled later", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    { ...asked(2, "Upgrade Twilio now?", ["Go", "Wait"]), app: "discord" },
  ]);
  writeFileSync(join(state, "voice", "check.json"), JSON.stringify(TWO_HUBS));
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await until(() => questions.find("check:twilio"));
  expect(await questions.dismiss("check:twilio", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 1,
    missed: 2,
  });
  await until(() => lines.length === 2);
  expect(lines.map((line) => line.type)).toEqual(["inbound", "settle"]);
  expect(await rejection(questions.dismiss("check:twilio", "app"))).toContain(
    "already answered or settled",
  );
  const twilio = questions.find("check:twilio");
  expect(twilio).toBeDefined();
  expect(twilio?.partly).toBeUndefined();

  ledger([
    {
      ...asked(1, "Twilio?", ["Upgrade", "Not yet"]),
      settled: { note: "✓ Not needed, said in the app", at: "" },
    },
    { ...asked(2, "Upgrade Twilio now?", ["Go", "Wait"]), app: "discord" },
  ]);
  await Bun.sleep(150);
  expect(questions.find("check:twilio")).toMatchObject({ partly: "Not needed" });
  const discord = await discordHub();

  try {
    expect(await questions.dismiss("check:twilio", "app")).toEqual({
      thread: `telegram:${DESK}`,
      topic: "desk",
      settled: 1,
      missed: 0,
    });
    await until(() => discord.heard.length === 2);
    expect(discord.heard.map((line) => line.type)).toEqual(["inbound", "settle"]);
    expect(lines.map((line) => line.type)).toEqual(["inbound", "settle"]);
    await questions.undo("check:twilio", "app");
    await until(() => discord.heard.length === 4 && lines.length === 4);
    expect(lines.slice(2).map((line) => line.type)).toEqual(["reopen", "inbound"]);
    expect(discord.heard.slice(2).map((line) => line.type)).toEqual(["reopen", "inbound"]);
    await Bun.sleep(50);
    expect([lines.length, discord.heard.length]).toEqual([4, 4]);
  } finally {
    await discord.stop();
  }
});

test("an answer that missed a copy is finished by the same answer, which only settles it, and no other answer goes over it", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    { ...asked(2, "Upgrade Twilio now?", ["Upgrade", "Not yet"]), app: "discord" },
  ]);
  writeFileSync(join(state, "voice", "check.json"), JSON.stringify(TWO_HUBS));
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await until(() => questions.find("check:twilio"));
  expect(await questions.answer("check:twilio", "Upgrade", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 1,
    missed: 1,
  });
  ledger([
    {
      ...asked(1, "Twilio?", ["Upgrade", "Not yet"]),
      answer: { label: "Upgrade", at: "", via: "app" },
    },
    { ...asked(2, "Upgrade Twilio now?", ["Upgrade", "Not yet"]), app: "discord" },
  ]);
  await Bun.sleep(150);
  expect(questions.find("check:twilio")).toMatchObject({ partly: "Upgrade" });
  expect(questions.find("check:twilio")?.undoing).toBeUndefined();
  expect(await rejection(questions.answer("check:twilio", "Not yet", "app"))).toContain(
    'part of "Upgrade" went out',
  );
  expect(await rejection(questions.dismiss("check:twilio", "app"))).toContain(
    'part of "Upgrade" went out',
  );
  const discord = await discordHub();

  try {
    expect(await questions.answer("check:twilio", "Upgrade", "app")).toEqual({
      thread: `telegram:${DESK}`,
      topic: "desk",
      settled: 1,
      missed: 0,
    });
    await until(() => discord.heard.length === 1);
    expect(discord.heard).toEqual([
      { type: "settle", thread: DESK, message: 2, note: "✓ Answered in the app: Upgrade" },
    ]);
  } finally {
    await discord.stop();
  }
});

test("an option labelled Not needed that missed a copy is finished as the answer it was, not as a not needed", async () => {
  const options = ["Upgrade", "Not needed"];

  const hubs = {
    ...TWO_HUBS,
    asks: [{ ...TWILIO, options: options.map((label) => ({ label, value: label })) }],
  };

  ledger([
    asked(1, "Twilio?", options),
    { ...asked(2, "Upgrade Twilio now?", options), app: "discord" },
  ]);
  writeFileSync(join(state, "voice", "check.json"), JSON.stringify(hubs));
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await until(() => questions.find("check:twilio"));
  await questions.answer("check:twilio", "Not needed", "app");
  ledger([
    { ...asked(1, "Twilio?", options), answer: { label: "Not needed", at: "", via: "app" } },
    { ...asked(2, "Upgrade Twilio now?", options), app: "discord" },
  ]);
  await Bun.sleep(150);
  expect(questions.find("check:twilio")).toMatchObject({ partly: "Not needed" });
  const discord = await discordHub();

  try {
    expect(await questions.answer("check:twilio", "Not needed", "call")).toEqual({
      thread: `telegram:${DESK}`,
      topic: "desk",
      settled: 1,
      missed: 0,
    });
    await until(() => discord.heard.length === 1);
    expect(discord.heard).toEqual([
      { type: "settle", thread: DESK, message: 2, note: "✓ Answered on a call: Not needed" },
    ]);
  } finally {
    await discord.stop();
  }
});

test("a question asked again while an earlier answer missed a copy is answered on the new copy, and the missed one only settles", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    { ...asked(2, "Twilio?", ["Upgrade", "Not yet"]), app: "discord" },
    asked(3, "Twilio, again?", ["Upgrade", "Not yet"]),
  ]);
  writeFileSync(join(state, "voice", "check.json"), JSON.stringify(TWO_HUBS));
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await until(() => questions.find("check:twilio"));
  await questions.answer("check:twilio", "Upgrade", "app");
  ledger([
    {
      ...asked(1, "Twilio?", ["Upgrade", "Not yet"]),
      answer: { label: "Upgrade", at: "", via: "app" },
    },
    { ...asked(2, "Twilio?", ["Upgrade", "Not yet"]), app: "discord" },
    asked(3, "Twilio, again?", ["Upgrade", "Not yet"]),
  ]);

  const again = {
    ...TWO_HUBS,
    asks: [
      {
        ...TWILIO,
        refs: [
          { app: "discord", thread: DESK, message: 2 },
          { app: "telegram", thread: DESK, message: 3 },
        ],
      },
    ],
  };

  writeFileSync(join(state, "voice", "check.json"), JSON.stringify(again));
  await Bun.sleep(150);
  expect(await questions.answer("check:twilio", "Not yet", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 1,
    missed: 1,
  });
  expect(await until(() => lines.find((line) => line.message === 3))).toEqual({
    type: "answer",
    thread: DESK,
    message: 3,
    label: "Not yet",
    via: "app",
  });
});

test("an undo with a hub down takes back what it can, keeps the rest, and finishes when tried again", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    { ...asked(2, "Upgrade Twilio now?", ["Go", "Wait"]), app: "discord" },
  ]);
  writeFileSync(join(state, "voice", "check.json"), JSON.stringify(TWO_HUBS));
  let discord = await discordHub();
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await until(() => questions.find("check:twilio"));
  expect(await questions.answer("check:twilio", "Upgrade", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 2,
    missed: 0,
  });
  await discord.stop();
  expect(await rejection(questions.undo("check:twilio", "app"))).toContain("undo again to finish");
  await until(() => lines.some((line) => line.type === "reopen"));
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    {
      ...asked(2, "Upgrade Twilio now?", ["Go", "Wait"]),
      app: "discord",
      settled: { note: "✓ Answered in the app: Upgrade", at: "" },
    },
  ]);
  await Bun.sleep(150);
  expect(questions.find("check:twilio")).toMatchObject({ undoing: true });
  expect(questions.find("check:twilio")?.partly).toBeUndefined();
  expect(await rejection(questions.answer("check:twilio", "Not yet", "app"))).toContain(
    "undo it again first",
  );
  discord = await discordHub();

  try {
    await questions.undo("check:twilio", "app");
    await until(() => discord.heard.some((line) => line.type === "reopen"));
    ledger([
      asked(1, "Twilio?", ["Upgrade", "Not yet"]),
      { ...asked(2, "Upgrade Twilio now?", ["Go", "Wait"]), app: "discord" },
    ]);
    await Bun.sleep(150);
    expect(await rejection(questions.undo("check:twilio", "app"))).toContain(
      "no answer here to take back",
    );
    expect(await questions.answer("check:twilio", "Not yet", "app")).toMatchObject({
      settled: 2,
      missed: 0,
    });
  } finally {
    await discord.stop();
  }
});

test("a question asked again over an earlier answer can be answered, and one undo takes back both", async () => {
  ledger([asked(1, "Ship it?", ["Yes", "No"]), asked(3, "Ship it now?", ["Yes", "No"])]);

  const check = (refs: number[]) => {
    writeFileSync(
      join(state, "voice", "check.json"),
      JSON.stringify({
        ...TWO_HUBS,
        asks: [
          {
            id: "check:ship",
            kind: "yesno",
            task: `telegram:${DESK}`,
            at: "",
            question: "Ship it",
            options: [
              { label: "Yes", value: "Yes" },
              { label: "No", value: "No" },
            ],
            refs: refs.map((message) => ({ app: "telegram", thread: DESK, message })),
          },
        ],
      }),
    );
  };

  check([1]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await until(() => questions.find("check:ship"));
  await questions.dismiss("check:ship", "app");
  ledger([
    {
      ...asked(1, "Ship it?", ["Yes", "No"]),
      settled: { note: "✓ Not needed, said in the app", at: "" },
    },
    asked(3, "Ship it now?", ["Yes", "No"]),
  ]);
  check([1, 3]);
  await Bun.sleep(150);
  expect(await questions.answer("check:ship", "Yes", "app")).toEqual({
    thread: `telegram:${DESK}`,
    topic: "desk",
    settled: 1,
    missed: 0,
  });
  await questions.undo("check:ship", "app");
  await until(() => lines.length === 6);
  expect(lines.slice(2)).toEqual([
    { type: "answer", thread: DESK, message: 3, label: "Yes", via: "app" },
    { type: "reopen", thread: DESK, message: 3, via: "app" },
    { type: "reopen", thread: DESK, message: 1, via: "app" },
    {
      type: "inbound",
      thread: DESK,
      content: "(took back) Ship it: Not needed",
      author: "owner",
      meta: { user: "hex app" },
    },
  ]);
});

test("a stuck item with a request goes to General once, however fast it is tapped twice, and one without is put away", async () => {
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T15:00:00.000Z",
      why: "a call ended",
      read: {},
      asks: [],
      fixed: [],
      flagged: [],
      stuck: [
        {
          id: "disk",
          title: "cloud’s disk fails every read",
          why: "Since 1:10am.",
          action: "Restore",
          mark: "failed",
          at: "",
          request: "Restore cloud from checkpoint v7.",
        },
        {
          id: "runs",
          title: "5 T3 runs ended in an error",
          why: "Their work landed.",
          action: "Settle",
          mark: "failed",
          at: "",
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  const [, twice] = await Promise.allSettled([questions.act("disk"), questions.act("disk")]);
  expect(twice).toMatchObject({
    status: "rejected",
    reason: new Error("that request is on its way"),
  });
  expect(await until(() => lines[0])).toEqual({
    type: "inbound",
    thread: GROUP,
    content: "Restore cloud from checkpoint v7.",
    author: "prompt",
    meta: { user: "hex app" },
  });
  await questions.act("runs");
  expect(lines).toHaveLength(1);
  await until(() => questions.view.stuck.length === 1);
  expect(questions.view.stuck[0]).toMatchObject({ id: "disk", app: "hex" });
  expect(questions.view.stuck[0]?.sent).toBeString();
  expect(savedMarks().dismissed.runs).toBeString();
});

test("T3 Code’s records give what waits on a limit, what never started, what failed unseen, and what finished since you looked", () => {
  const path = join(state, "t3.sqlite");
  const db = new Database(path);
  db.run(
    `create table orchestration_v2_projection_threads (thread_id text, project_id text, title text, archived_at text, deleted_at text, payload_json text)`,
  );
  db.run(`create table projection_projects (project_id text, title text, workspace_root text)`);
  db.run(
    `create table orchestration_v2_projection_runs (thread_id text, ordinal int, status text, requested_at text, completed_at text)`,
  );
  db.run(
    `create table orchestration_v2_projection_messages (thread_id text, role text, created_at text, payload_json text)`,
  );
  db.run(
    `insert into projection_projects values ('p', 'hex', '/code/hex'), ('home', '~', ?), ('none', 'No project', ?)`,
    [homedir(), join(homedir(), ".t3", "scratch")],
  );

  type Payload = {
    limitRecovery?: { resetAt: string };
    lastVisitedAt?: string;
    createdBy?: string;
  };

  const thread = (id: string, payload: Payload, project = "p") =>
    db.run(`insert into orchestration_v2_projection_threads values (?, ?, ?, null, null, ?)`, [
      id,
      project,
      `${id} thread`,
      JSON.stringify(payload),
    ]);

  thread("parked", { limitRecovery: { resetAt: "2026-10-18T19:00:00.000Z" } });
  thread("queued", {});
  thread("broken", { lastVisitedAt: "2026-10-13T08:00:00.000Z" });
  thread("finished", { createdBy: "user", lastVisitedAt: "2026-10-13T08:00:00.000Z" });
  thread("seen", { createdBy: "user", lastVisitedAt: "2026-10-13T12:00:00.000Z" });
  thread("loose", { createdBy: "user" }, "home");
  thread("scratch", { createdBy: "user" }, "none");

  const run = (id: string, ordinal: number, status: string, completed: string | null) =>
    db.run(
      `insert into orchestration_v2_projection_runs values (?, ?, ?, '2026-10-09T23:00:00.000Z', ?)`,
      [id, ordinal, status, completed],
    );

  run("parked", 1, "failed", "2026-10-13T10:00:00.000Z");
  run("queued", 1, "queued", null);
  run("broken", 1, "failed", "2026-10-13T10:00:00.000Z");
  run("finished", 1, "completed", "2026-10-13T10:00:00.000Z");
  run("seen", 1, "completed", "2026-10-13T10:00:00.000Z");
  run("loose", 1, "completed", "2026-10-13T09:00:00.000Z");
  run("scratch", 1, "completed", "2026-10-13T08:00:00.000Z");
  db.run(
    `insert into orchestration_v2_projection_messages values ('finished', 'assistant', '2026-10-13T10:00:00.000Z', ?)`,
    [JSON.stringify({ text: "## Done\n\n**Shipped** the memory fix." })],
  );
  db.close();

  const t3 = new T3(() => {}, path);
  const { stuck, fresh } = t3.query(Date.parse("2026-10-13T20:00:00.000Z"));
  t3.close();
  expect(stuck.map((item) => [item.title, item.action, item.mark])).toEqual([
    ["1 T3 thread waits for Oct 18", "Switch plan", "paused"],
    ["queued thread: queued since Oct 9", "Resume", "paused"],
    ["broken thread ended in an error", "Look", "failed"],
  ]);
  expect(stuck.every((item) => item.request !== undefined && item.request !== "")).toBe(true);
  expect(fresh.map((item) => [item.topic, item.where])).toEqual([
    ["hex", "T3 · hex"],
    ["loose thread", "T3"],
    ["scratch thread", "T3"],
  ]);
  const [done] = fresh;
  expect(done?.id).toMatch(/^t3-done-/u);
  expect({ ...done, id: "t3-done-…" }).toEqual({
    id: "t3-done-…",
    app: "t3",
    topic: "hex",
    title: "finished thread",
    where: "T3 · hex",
    line: "Done",
    at: "2026-10-13T10:00:00.000Z",
  });
  expect(stuck.every((item) => item.app === "t3")).toBe(true);
});

test("a check’s verdict is held to the ledger: real open refs and buttons only, and nothing both settled and listed", () => {
  const ledgers = {
    telegram: [
      asked(1, "Twilio?", ["Upgrade", "Not yet"]),
      asked(2, "Old?", ["Yes", "No"], { settled: { note: "x", at: "" } }),
      asked(3, "Music?", ["A", "B"]),
    ],
  };

  const ref = (message: number) => ({ app: "telegram", thread: DESK, message });

  const verdict = vet(
    {
      asks: [
        {
          id: "twilio",
          kind: "do",
          task: `telegram:${DESK}`,
          at: "",
          question: "Upgrade Twilio",
          options: [
            { label: "Upgrade", value: "Upgrade" },
            { label: "Later", value: "Wait" },
          ],
          from: [
            ref(1),
            ref(2),
            ref(9),
            { app: "telegram", thread: GROUP },
            { app: "telegram", thread: "-100999" },
            { app: "voice", call: "live_1" },
            { app: "voice", call: "live_made_up" },
          ],
        },
      ],
      settle: [
        { ...ref(1), note: "Settled" },
        { ...ref(2), note: "Settled" },
        { ...ref(3), note: "Settled: Tech Live, picked on a call with a very long note" },
      ],
      fixed: [],
      flagged: [],
      stuck: [{ id: "disk", title: "disk", why: "", action: "Look", mark: "failed", at: "" }],
    },
    ledgers,
    {
      threads: { [`telegram:${GROUP}`]: "hex", [`telegram:${DESK}`]: "desk" },
      calls: [{ id: "live_1" }],
    },
  );

  expect(verdict.asks[0]).toMatchObject({
    id: "check:twilio",
    refs: [ref(1)],
    from: [
      ref(1),
      ref(2),
      ref(9),
      { app: "telegram", thread: GROUP },
      { app: "voice", call: "live_1" },
    ],
    options: [{ label: "Upgrade", value: "Upgrade" }, { label: "Later" }],
  });
  expect(verdict.settle).toEqual([
    { ...ref(3), note: "Settled: Tech Live, picked on a call with a very long note".slice(0, 60) },
  ]);
  expect(verdict.stuck[0]?.id).toBe("check-disk");
});

test("a closed thread's open question stays a check's ref, so answering the question settles it", () => {
  const closed = { app: "telegram", thread: `${GROUP}:7`, message: 4 };

  const verdict = vet(
    {
      asks: [
        {
          id: "music",
          kind: "pick",
          task: `telegram:${GROUP}:7`,
          at: "",
          question: "Music?",
          options: [{ label: "A", value: "A" }],
          from: [closed],
        },
      ],
      settle: [],
      fixed: [],
      flagged: [],
      stuck: [],
    },
    { telegram: [asked(4, "Music?", ["A", "B"], { thread: closed.thread })] },
    { threads: {}, calls: [] },
  );

  expect(verdict.asks[0]).toMatchObject({
    refs: [closed],
    from: [closed],
    options: [{ label: "A", value: "A" }],
  });
});

test("a question names every place it was asked, each thread once at its open question, pinned post or message, with the best link its app has, the ones that open first, and its pages apart from its answers", async () => {
  const DM = "777";
  const THREAD = "1560277464146644992";
  open(state).threads.keep("telegram", {
    [GROUP]: { name: "hex", link: "https://t.me/c/1234/1" },
    [DESK]: { name: "desk", link: "https://t.me/c/1234/5" },
    [DM]: { name: "DM", link: "https://t.me/hexbot" },
  });
  mkdirSync(join(state, "discord"));
  open(state).threads.keep("discord", {
    [THREAD]: { name: "fix hex NOW", link: `https://discord.com/channels/42/${THREAD}` },
  });
  const calls = join(state, "calls");
  mkdirSync(calls);
  writeFileSync(
    join(calls, "live_1.json"),
    JSON.stringify({ id: "live_1", title: "Apple charges", started: "2026-10-13T18:00:00.000Z" }),
  );
  ledger(
    [
      asked(1, "Order the laptop?", ["Ordered", "Not yet"]),
      {
        thread: GROUP,
        message: 3401,
        text: "Laptop ordered?",
        options: ["Yes", "No"],
        at: "2026-10-13T12:00:00.000Z",
      },
    ],
    {
      [GROUP]: {
        message: 2693,
        text: "Blocked on you: the laptop order",
        at: "2026-10-13T19:00:00.000Z",
      },
      [DESK]: { message: 4, text: "Laptop order", at: "2026-10-13T21:00:00.000Z" },
    },
  );
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T20:00:00.000Z",
      why: "a call ended",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:laptop",
          kind: "yesno",
          task: `telegram:${DESK}`,
          at: "2026-10-13T11:00:00.000Z",
          question: "Is the Laptop ordered?",
          options: [
            { label: "Ordered", value: "Ordered" },
            { label: "Not yet", value: "Not yet" },
          ],
          links: [{ label: "Apple Store", url: "https://apple.com/store" }],
          from: [
            { app: "telegram", thread: DESK, message: 4 },
            { app: "telegram", thread: DESK, message: 1 },
            { app: "telegram", thread: GROUP, message: 2693 },
            { app: "telegram", thread: GROUP, message: 3000 },
            { app: "voice", call: "live_1" },
            { app: "telegram", thread: DM, message: 585 },
            { app: "discord", thread: THREAD },
            { app: "telegram", thread: DESK },
            { app: "telegram", thread: DM },
          ],
          refs: [{ app: "telegram", thread: DESK, message: 1 }],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    calls,
    check: (why) => {
      checks.push(why);
    },
  });
  const [laptop] = questions.view.asks;
  expect(laptop).toMatchObject({
    options: [
      { label: "Ordered", value: "Ordered" },
      { label: "Not yet", value: "Not yet" },
    ],
    links: [{ label: "Apple Store", url: "https://apple.com/store" }],
  });
  expect(laptop?.places).toEqual([
    {
      app: "telegram",
      place: "General",
      task: `telegram:${GROUP}`,
      link: "https://t.me/c/1234/2693",
    },
    { app: "telegram", place: "desk", task: `telegram:${DESK}`, link: "https://t.me/c/1234/5/1" },
    { app: "telegram", place: "DM", task: `telegram:${DM}`, link: "https://t.me/hexbot" },
    {
      app: "discord",
      place: "fix hex NOW",
      task: `discord:${THREAD}`,
      link: `https://discord.com/channels/42/${THREAD}`,
    },
    { app: "voice", place: "Apple charges", call: "live_1" },
  ]);
  writeFileSync(
    join(calls, "live_1.json"),
    JSON.stringify({ id: "live_1", title: "Apple refund", started: "2026-10-13T18:00:00.000Z" }),
  );
  const version = questions.version;
  const check = join(state, "voice", "check.json");
  writeFileSync(check, readFileSync(check));
  await questions.changes(version, 2000);
  expect(questions.view.asks[0]?.places.at(-1)).toEqual({
    app: "voice",
    place: "Apple refund",
    call: "live_1",
  });
});

test("a status post's page is read from hex.db as it opens, and only a new note starts a check, not the lines hex rewrites", async () => {
  const pin = {
    message: 7,
    text: "Site: example.com\n\n**🔴 Blocked on you:** no questions waiting",
    at: "2026-10-13T10:00:00.000Z",
    note: "Site: example.com",
  };

  const byHand = { message: 2, text: "Status: by hand", at: "2026-10-13T10:00:00.000Z" };
  ledger([asked(1, "Ship it?", ["Yes", "No"])], { [DESK]: pin, [GROUP]: byHand });
  const store = open(state);
  store.messages.deliver({
    key: "telegram:-1001234:40",
    to: DESK,
    from: "telegram",
    body: "Fix the login page",
    author: "owner",
    meta: { user: "owner" },
  });

  const task = store.tasks.create({
    title: "Fix the login page",
    message: "telegram:-1001234:40",
    owner: DESK,
  });

  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });

  const shown = `Site: example.com\n\n**Waiting on you**\n- Ship it?\n\n**Open**\n- ${task.title}`;
  expect(questions.of(`telegram:${DESK}`).pin).toBe(shown);
  expect(questions.of(`telegram:${GROUP}`).pin).toBe("Status: by hand");

  store.pins.pinned({
    app: "telegram",
    thread: DESK,
    ...pin,
    text: shown,
  });
  await Bun.sleep(150);
  expect(checks).toEqual([]);
  store.pins.pinned({ app: "telegram", thread: DESK, ...pin, note: "Site: example.org" });
  await until(() => checks.length);
  expect(checks).toEqual(["a pinned post changed"]);
});

test("an answered ask the check lists again without buttons is flagged, not listed", () => {
  const ask = {
    id: "check:sign-in",
    kind: "do" as const,
    task: `telegram:${DESK}`,
    at: new Date().toISOString(),
    question: "Sign in",
    options: [{ label: "Done" }],
    from: [],
  };

  const signedIn = { label: "Done", at: "2026-10-13T12:00:00.000Z", via: "app" };

  const verdict = vet(
    { asks: [ask, { ...ask, id: "check:other" }], settle: [], fixed: [], flagged: [], stuck: [] },
    {},
    {
      threads: {},
      calls: [],
      answered: { "check:sign-in": signedIn },
    },
  );

  expect(verdict.asks.map((question) => question.id)).toEqual(["check:other"]);
  expect(verdict.flagged).toEqual([
    {
      title: "Sign in",
      text: 'You answered this "Done" on 2026-10-13, and the check found it asked again.',
    },
  ]);
});

test("the check's fingerprint takes in the answers it reads, and stays the same for the same records", () => {
  type Records = Parameters<typeof digest>[0];

  const records = (answered: Records["answered"]): Records => ({
    now: "",
    threads: {},
    open: [],
    closed: [],
    answered,
    pins: [],
    calls: [],
    t3: { stuck: [], fresh: [] },
    previous: undefined,
    ledgers: {},
  });

  const seen = { label: "Seen", at: "2026-10-13T00:00:00.000Z", via: "app" };
  expect(digest(records({ "check:read": seen }))).toBe(
    digest(records({ "check:read": { ...seen } })),
  );
  expect(digest(records({ "check:read": seen }))).not.toBe(digest(records({})));
});

test("a check's links keep only what opens a page or an app on the phone", () => {
  const urls = [
    "https://github.com/a/b/pull/2",
    "http://100.1.2.3:4800/page",
    "tg://resolve?domain=hexbot",
    "t3code://threads/env/1",
    "buzz://channel/x",
    "discord://-/channels/1",
    "file:///home/a/report.md",
    // oxlint-disable-next-line eslint/no-script-url -- a link the check has to drop
    "javascript:alert(1)",
    "/home/a/report.md",
  ];

  const verdict = vet(
    {
      asks: [
        {
          id: "read",
          kind: "look",
          task: `telegram:${DESK}`,
          at: new Date().toISOString(),
          question: "Read it",
          options: [{ label: "Seen" }],
          links: urls.map((url) => ({ label: "Page", url })),
          from: [],
        },
      ],
      settle: [],
      fixed: [],
      flagged: [],
      stuck: [],
    },
    {},
    { threads: {}, calls: [] },
  );

  expect(verdict.asks[0]?.links?.map((link) => link.url)).toEqual(urls.slice(0, 5));
});

test("an answer with no buttons is kept for good, other marks and unfinished answers for 14 days", () => {
  const old = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();

  const answers = {
    "check:read": { label: "Seen", at: old, via: "app" },
    "check:poll": {
      label: "A",
      at: old,
      via: "app",
      refs: [{ app: "telegram", thread: DESK, message: 1 }],
      told: [],
    },
    "check:half": { label: "B", at: old, via: "app", refs: [], told: [], undoing: true },
  };

  writeFileSync(
    join(state, "voice", "marks.json"),
    JSON.stringify({ answers, read: { "t3-done-0": old } }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  questions.read("t3-done-1");
  const marks = savedMarks();
  expect([Object.keys(marks.answers), Object.keys(marks.read)]).toEqual([
    ["check:read"],
    ["t3-done-1"],
  ]);
});

test("an old answer whose undo stops partway is kept until it is undone again", async () => {
  const old = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: old,
      why: "a call ended",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:read",
          kind: "look",
          task: `telegram:${DESK}`,
          at: old,
          question: "Read it",
          options: [{ label: "Seen" }],
        },
      ],
    }),
  );
  writeFileSync(
    join(state, "voice", "marks.json"),
    JSON.stringify({
      answers: {
        "check:read": {
          label: "Seen",
          at: old,
          via: "app",
          question: "Read it",
          told: [`telegram:${DESK}`],
          refs: [],
          missed: [],
        },
      },
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await new Promise((resolve) => {
    hub.close(resolve);
  });
  expect(await rejection(questions.undo("check:read", "app"))).toContain("undo again to finish");
  expect(savedMarks().answers["check:read"]).toMatchObject({ undoing: true });
});

test("an ask read out by its own id, which a check then takes up under one of its own, is still answered by the id the caller heard", async () => {
  ledger([asked(9, "Ship it?", ["Yes", "No"])]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  const heard = `telegram:${DESK}:9`;
  expect(questions.find(heard)).toBeDefined();
  const version = questions.version;
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T15:00:00.000Z",
      why: "a call ended",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:ship",
          kind: "yesno",
          task: `telegram:${DESK}`,
          at: "2026-10-13T19:00:00.000Z",
          question: "Ship it",
          options: [
            { label: "Yes", value: "Yes" },
            { label: "No", value: "No" },
          ],
          refs: [{ app: "telegram", thread: DESK, message: 9 }],
        },
      ],
    }),
  );
  open(state).questions.ask(asked(8, "Unrelated?", ["A"]));
  await questions.changes(version, 2000);
  await until(() => questions.view.asks.some((question) => question.id === "check:ship"));
  expect(questions.find(heard)?.id).toBe("check:ship");
  expect(await questions.answer(heard, "Yes", "call")).toMatchObject({
    thread: `telegram:${DESK}`,
    settled: 1,
    missed: 0,
  });
  expect(await until(() => lines[0])).toEqual({
    type: "answer",
    thread: DESK,
    message: 9,
    label: "Yes",
    via: "call",
  });
  expect(questions.answered("check:ship")).toBe(true);
  await questions.undo(heard, "call");
  expect(await until(() => lines.find((line) => line.type === "reopen"))).toEqual({
    type: "reopen",
    thread: DESK,
    message: 9,
    via: "call",
  });
  expect(questions.answered("check:ship")).toBe(false);
});

function twoTwilios(fields: Partial<Question> = {}) {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"], fields),
    asked(2, "Upgrade Twilio now?", ["Upgrade", "Wait"], fields),
  ]);
}

test("a check's ask undone after a later check let it go stays one card, and answering it reaches every copy once, however often it's undone", async () => {
  const check = (asks: Curated[]) => {
    writeFileSync(
      join(state, "voice", "check.json"),
      JSON.stringify({
        at: "2026-10-13T15:00:00.000Z",
        why: "a call ended",
        read: {},
        fixed: [],
        flagged: [],
        stuck: [],
        asks,
      }),
    );
  };

  twoTwilios();
  check([
    {
      id: "check:twilio",
      kind: "yesno",
      task: `telegram:${DESK}`,
      at: "2026-10-11T00:00:00.000Z",
      question: "Upgrade Twilio from trial",
      options: [{ label: "Upgrade", value: "Upgrade" }],
      refs: [
        { app: "telegram", thread: DESK, message: 1 },
        { app: "telegram", thread: DESK, message: 2 },
      ],
    },
  ]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  await questions.answer("check:twilio", "Upgrade", "app");
  let version = questions.version;
  twoTwilios({ answer: { label: "Upgrade", at: "", via: "app" } });
  check([]);
  await questions.changes(version, 2000);
  await until(() => !questions.view.asks.length);

  await questions.undo("check:twilio", "app");
  await until(() => lines.filter((line) => line.type === "reopen").length === 2);
  version = questions.version;
  twoTwilios();
  await questions.changes(version, 2000);
  await until(() => questions.view.asks.length);
  expect(questions.view.asks.map((question) => [question.id, question.question])).toEqual([
    ["check:twilio", "Upgrade Twilio from trial"],
  ]);

  lines.length = 0;
  await questions.answer("check:twilio", "Upgrade", "app");
  await until(() => lines.length === 2);
  expect(lines).toEqual([
    { type: "answer", thread: DESK, message: 1, label: "Upgrade", via: "app" },
    { type: "settle", thread: DESK, message: 2, note: "✓ Answered in the app: Upgrade" },
  ]);

  version = questions.version;
  twoTwilios({ answer: { label: "Upgrade", at: "", via: "app" } });
  await questions.changes(version, 2000);
  await until(() => !questions.view.asks.length);
  lines.length = 0;
  await questions.undo("check:twilio", "app");
  await until(() => lines.filter((line) => line.type === "reopen").length === 2);
  version = questions.version;
  twoTwilios();
  await questions.changes(version, 2000);
  await until(() => questions.view.asks.length);
  expect(questions.view.asks.map((question) => question.id)).toEqual(["check:twilio"]);
  lines.length = 0;
  await questions.answer("check:twilio", "Upgrade", "app");
  await Bun.sleep(200);
  expect(lines).toEqual([
    { type: "answer", thread: DESK, message: 1, label: "Upgrade", via: "app" },
    { type: "settle", thread: DESK, message: 2, note: "✓ Answered in the app: Upgrade" },
  ]);
});

test("an answer still on its way counts as given, so an undo it turns away is not taken for one that went through", async () => {
  ledger([asked(1, "Ship it?", ["Yes", "No"])]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  const id = `telegram:${DESK}:1`;
  const going = questions.answer(id, "Yes", "app");
  expect(await rejection(questions.undo(id, "app"))).toContain("still on its way");
  expect(questions.answered(id)).toBe(true);
  await going;
  expect(questions.answered(id)).toBe(true);
});

test("a check's ask names the ids its questions were listed under before it took them up, so the app keeps what was typed on them", async () => {
  ledger([
    asked(1, "Twilio?", ["Upgrade", "Not yet"]),
    asked(2, "Upgrade Twilio now?", ["Upgrade", "Wait"]),
  ]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: (why) => {
      checks.push(why);
    },
  });
  expect(questions.view.asks.map((question) => [question.id, question.was])).toEqual([
    [`telegram:${DESK}:2`, undefined],
    [`telegram:${DESK}:1`, undefined],
  ]);
  const version = questions.version;
  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T15:00:00.000Z",
      why: "a call ended",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:twilio",
          kind: "yesno",
          task: `telegram:${DESK}`,
          at: "2026-10-11T00:00:00.000Z",
          question: "Upgrade Twilio from trial",
          options: [{ label: "Upgrade", value: "Upgrade" }],
          refs: [
            { app: "telegram", thread: DESK, message: 1 },
            { app: "telegram", thread: DESK, message: 2 },
          ],
        },
      ],
    }),
  );
  await questions.changes(version, 2000);
  expect(questions.view.asks.map((question) => [question.id, question.was])).toEqual([
    ["check:twilio", [`telegram:${DESK}:1`, `telegram:${DESK}:2`]],
  ]);
});

test("General hears of the first failed check in a run of them, and of the first after one succeeds", () => {
  const store = open(state);
  store.threads.keep("telegram", { [GROUP]: { name: "hex" } });
  mkdirSync(join(state, "voice", "check"), { recursive: true });

  const told = () =>
    store.db
      .query<{ body: string }, [string]>(
        `select body from messages where "to" = ? and "from" = 'check'`,
      )
      .all(GROUP)
      .map((row) => row.body);

  failed(state, "monday: the check hit a limit");
  failed(state, "tuesday: the check hit a limit");
  expect(told()).toHaveLength(1);
  expect(told()[0]).toContain("monday: the check hit a limit");
  expect(readFileSync(join(state, "voice", "check", "error"), "utf-8")).toBe(
    "tuesday: the check hit a limit\n",
  );
  rmSync(join(state, "voice", "check", "error"));
  failed(state, "wednesday: the check hit a limit");
  expect(told()).toHaveLength(2);
});

test("an ask stays only while a place still asks it: an open question, an open thread's pinned post, a recent call, or a message from the last three days", () => {
  const old = new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString();

  const ask = (id: string, at: string, from: Source[]) => ({
    id,
    kind: "do" as const,
    task: `telegram:${DESK}`,
    at,
    question: id,
    options: [{ label: "Done" }],
    from,
  });

  const verdict = vet(
    {
      asks: [
        ask("question", old, [{ app: "telegram", thread: DESK, message: 1 }]),
        ask("pin", old, [{ app: "telegram", thread: DESK, message: 50 }]),
        ask("call", old, [{ app: "voice", call: "live_1" }]),
        ask("recent", new Date().toISOString(), [{ app: "telegram", thread: DESK, message: 60 }]),
        ask("stale", old, [{ app: "telegram", thread: DESK, message: 60 }]),
        ask("old-pin", old, [{ app: "telegram", thread: DESK, message: 40 }]),
      ],
      settle: [],
      fixed: [],
      flagged: [],
      stuck: [],
    },
    { telegram: [asked(1, "Twilio?", ["Upgrade", "Not yet"])] },
    {
      threads: { [`telegram:${DESK}`]: "desk" },
      calls: [{ id: "live_1" }],
      pins: [{ app: "telegram", thread: DESK, message: 50 }],
    },
  );

  expect(verdict.asks.map((question) => question.id)).toEqual([
    "check:question",
    "check:pin",
    "check:call",
    "check:recent",
  ]);
});

test("a check's ask keeps why hex picks and what each option does, for the app's page of picks", () => {
  const options = [
    {
      label: "AWS twin",
      pick: true,
      detail: "A full copy of the server, about $25 a month after credit.",
    },
    { label: "Sprite", detail: "Free, at half the speed." },
  ];

  const verdict = vet(
    {
      asks: [
        {
          id: "standby",
          kind: "pick",
          task: `telegram:${DESK}`,
          at: new Date().toISOString(),
          question: "Which standby box?",
          why: "It is the only one as fast as the server.",
          options,
          from: [],
        },
      ],
      settle: [],
      fixed: [],
      flagged: [],
      stuck: [],
    },
    {},
    { threads: {}, calls: [] },
  );

  expect(verdict.asks[0]).toMatchObject({
    why: "It is the only one as fast as the server.",
    options,
  });
});

test("each option that stands for a poll's option shows its screenshot at its shape, redrawn too, raw and once a check takes it up and renames it", () => {
  ledger([
    asked(7, "One call button?", ["One (my pick)", "Both"], {
      shots: [png(state, "one", 40, 20), png(state, "both", 10, 20)],
      poll: "p7",
    }),
    asked(8, "Ship it?", ["Yes", "No"]),
  ]);
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: () => {},
  });
  const raw = `telegram:${DESK}:7`;
  expect(questions.find(raw)?.options.map((option) => [option.shot, option.shape])).toEqual([
    [0, 2],
    [1, 0.5],
  ]);
  expect(questions.shot(raw, 1)).toBe(join(state, "both.png"));
  questions.close();
  png(state, "both", 30, 10);
  utimesSync(join(state, "both.png"), new Date(), new Date(Date.now() + 1000));
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: () => {},
  });
  expect(questions.find(raw)?.options[1]?.shape).toBe(3);
  expect(questions.find(`telegram:${DESK}:8`)?.options.map((option) => option.shot)).toEqual([
    undefined,
    undefined,
  ]);
  questions.close();

  writeFileSync(
    join(state, "voice", "check.json"),
    JSON.stringify({
      at: "2026-10-13T20:00:00.000Z",
      why: "a call ended",
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: "check:button",
          kind: "pick",
          task: `telegram:${DESK}`,
          at: "",
          question: "One call button on the project page?",
          options: [
            { label: "Both", value: "Both" },
            { label: "One button", value: "One (my pick)", pick: true },
            { label: "Neither", shot: 1 },
          ],
          refs: [{ app: "telegram", thread: DESK, message: 7 }],
        },
      ],
    }),
  );
  questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: () => {},
  });
  expect(questions.find("check:button")?.options.map((option) => option.shot)).toEqual([
    1,
    0,
    undefined,
  ]);
  expect(questions.shot("check:button", 0)).toBe(join(state, "one.png"));
  expect(questions.shot(raw, 0)).toBe(join(state, "one.png"));
  expect(questions.shot("check:button", 2)).toBeUndefined();
});

function png(dir: string, name: string, width: number, height: number) {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(0x89_50_4e_47, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  const file = join(dir, `${name}.png`);
  writeFileSync(file, bytes);

  return file;
}
