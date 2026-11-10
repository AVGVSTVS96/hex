import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clients, open } from "@hex/hub";
import type { Client, Hub, Store } from "@hex/hub";

import { answer, list, read } from "./chats.ts";

const DM = "1";
const GENERAL = "-100";
const DESK = "-100:5";
const QUIET = "-100:6";

const NAMES = new Map([
  [DM, "DM"],
  [GENERAL, "hex"],
  [DESK, "Desk"],
  [QUIET, "Quiet"],
]);

let hexDir: string;
let store: Store;
let delivered: unknown[][];

function telegram(file?: Client["file"]): Client {
  const hub: Pick<Hub, "name" | "deliver" | "threads" | "fresh" | "main"> = {
    name: (thread) => NAMES.get(thread),
    deliver: (...args) => {
      delivered.push(args);

      return true;
    },
    threads: () => [...NAMES.keys()],
    fresh: (thread) => thread === DM,
    main: GENERAL,
  };

  // SAFETY: the iikb channel reaches a client's hub only through these five.
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fake of the five the channel uses
    hub: hub as Hub,
    place: () => Promise.resolve({ thread: "", link: "" }),
    ...(file && { file }),
  };
}

const say = (
  thread: string,
  n: number | string,
  author: "owner" | "hex",
  body: string,
  meta?: Record<string, string>,
) => {
  const key = `telegram:${thread}:${String(n)}`;

  store.messages.deliver({
    key,
    to: thread,
    from: "telegram",
    author,
    body,
    ...(meta && { meta }),
  });
  store.messages.take(key, "s1");
};

const ask = (path: string, init?: RequestInit) =>
  answer(store, new Request(`http://iikb${path}`, init), "secret");

type Sent = {
  text: string;
  id: string;
  files?: { type: string; data: string; width?: number; height?: number }[];
};

const post = (path: string, body: Sent, token = "secret") =>
  ask(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const aFreshHexDbRunsEveryMigrationForSecondsOnALoadedMachine = 30_000;

beforeEach(() => {
  hexDir = mkdtempSync(join(tmpdir(), "iikb-"));
  mkdirSync(join(hexDir, "state"));
  store = open(join(hexDir, "state"));
  delivered = [];
  clients.set("telegram", telegram());
}, aFreshHexDbRunsEveryMigrationForSecondsOnALoadedMachine);

afterEach(() => {
  clients.clear();
  rmSync(hexDir, { recursive: true, force: true });
});

test("the DM and General come first, then threads by their latest message, each with its last line", () => {
  say(QUIET, 1, "owner", "old news");
  say(DESK, 1, "owner", "ship it");
  say(DESK, 2, "hex", "Shipped.\nBuild 9 is on your phone.");

  expect(list(store)).toEqual([
    { id: "telegram:1", name: "DM", pinned: true },
    { id: "telegram:-100", name: "General", pinned: true },
    { id: "telegram:-100:5", name: "Desk", line: "Shipped." },
    { id: "telegram:-100:6", name: "Quiet", line: "old news" },
  ]);
});

test("only Telegram's threads are chats, since Chats is the owner's Telegram", () => {
  clients.set("discord", telegram());

  expect(list(store).map(({ id }) => id)).toEqual([
    "telegram:1",
    "telegram:-100",
    "telegram:-100:5",
    "telegram:-100:6",
  ]);
});

test("a chat reads as Telegram shows it: edits in place, a poll's options, and no reactions, taps or votes", async () => {
  say(DESK, 1, "hex", "Status: building");
  say(DESK, "e1", "hex", "Status: shipped", { edited: "true", message_id: "1" });
  say(DESK, 2, "hex", "Which one?", { poll: "A, the quick one / B" });
  say(DESK, 3, "owner", "(vote: B)", { vote: "B", poll_message_id: "2" });
  say(DESK, 4, "owner", "(reaction: 👍)", { reaction: "👍", reaction_to_message_id: "1" });
  say(DESK, 5, "owner", "Run now", { button: "true", button_message_id: "2" });
  say(DESK, 6, "owner", "typo", { message_id: "6" });
  say(DESK, "6@9", "owner", "fixed", { message_id: "6", edited: "true" });

  expect((await read(store, "telegram:-100:5")).messages).toEqual([
    { from: "hex", text: "Status: shipped" },
    { from: "hex", text: "Which one?\n\n• A, the quick one\n• B" },
    { from: "me", text: "fixed" },
  ]);
});

test("photos and files come as files the keyboard fetches with its token, the owner's from disk and hex's from Telegram", async () => {
  const photo = join(hexDir, "state", "photo.jpg");
  const report = join(hexDir, "state", "report.pdf");

  writeFileSync(photo, "jpeg bytes");
  writeFileSync(report, "pdf bytes");
  clients.set(
    "telegram",
    telegram((id) => Promise.resolve(id === "doc1" ? report : "")),
  );
  say(DESK, 1, "owner", "(photo)", { image_path: photo, image_dimensions: "1280x960" });
  say(DESK, 2, "hex", "(file: report.pdf)", {
    file: "report.pdf",
    attachment_kind: "document",
    attachment_file_id: "doc1",
    attachment_mime: "application/pdf",
  });

  const { messages } = await read(store, "telegram:-100:5");

  expect(messages).toEqual([
    {
      from: "me",
      text: "",
      files: [
        {
          name: "photo.jpg",
          url: "files/telegram%3A-100%3A5%3A1/0",
          type: "image/jpeg",
          width: 1280,
          height: 960,
        },
      ],
    },
    {
      from: "hex",
      text: "",
      files: [
        { name: "report.pdf", url: "files/telegram%3A-100%3A5%3A2/0", type: "application/pdf" },
      ],
    },
  ]);

  const fetched = await Promise.all(
    messages.map((message) =>
      ask(`/${message.files?.[0]?.url ?? ""}`, { headers: { authorization: "Bearer secret" } }),
    ),
  );

  expect(await Promise.all(fetched.map(async (response) => await response.text()))).toEqual([
    "jpeg bytes",
    "pdf bytes",
  ]);
  expect(fetched[1]?.headers.get("content-type")).toBe("application/pdf");
  expect(
    (await ask("/files/telegram%3A-100%3A5%3A9/0", { headers: { authorization: "Bearer secret" } }))
      .status,
  ).toBe(404);
});

test("a chat is what was said in it, then the owner's words its session hasn't taken yet", async () => {
  say(DESK, 1, "owner", "ship it");
  say(DESK, 2, "hex", "Shipped.");
  store.messages.deliver({
    key: "telegram:x",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "and docs",
  });

  expect((await read(store, "telegram:-100:5")).messages).toEqual([
    { from: "me", text: "ship it" },
    { from: "hex", text: "Shipped." },
    { from: "me", text: "and docs", pending: true },
  ]);
});

test("a chat is its newest 40 messages, however much Telegram doesn't show comes after them", async () => {
  for (let n = 1; n <= 50; n += 1) {
    say(DESK, n, "owner", `message ${String(n)}`);
  }

  for (let n = 51; n <= 250; n += 1) {
    say(DESK, n, "owner", "👍", { reaction: "👍" });
  }

  const { messages } = await read(store, "telegram:-100:5");

  expect(messages.map(({ text }) => text)).toEqual(
    Array.from({ length: 40 }, (_, at) => `message ${String(at + 11)}`),
  );
  expect(list(store).find(({ id }) => id === "telegram:-100:5")?.line).toBe("message 50");
});

test("a read after a version waits for the next message, and returns the moment it's written", async () => {
  say(DESK, 1, "owner", "ship it");
  const { version } = await read(store, "telegram:-100:5");
  const next = read(store, "telegram:-100:5", version);

  say(DESK, 2, "hex", "Shipped.");

  expect((await next).messages.at(-1)).toEqual({ from: "hex", text: "Shipped." });
});

test("words sent from the keyboard reach the thread as the owner's, from iikb, under the keyboard's id", async () => {
  const response = await post("/telegram%3A-100%3A5", { text: "and the tests", id: "m1" });

  expect(response.status).toBe(204);
  expect(delivered).toMatchObject([
    [
      "-100:5",
      "Desk",
      { content: "and the tests", key: "iikb-m1", author: "owner", meta: { user: "iikb" } },
    ],
  ]);
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x6a, 0x70, 0x65, 0x67]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70]);

test("photos sent from the keyboard are kept on disk and reach the thread as Telegram's own photos do, its words as the caption", async () => {
  const jpeg = JPEG.toString("base64");

  const response = await post("/telegram%3A-100%3A5", {
    text: "the new icon",
    id: "m5",
    files: [
      { type: "image/jpeg", data: jpeg, width: 1600, height: 1200 },
      { type: "image/png", data: PNG.toString("base64") },
    ],
  });

  expect(response.status).toBe(204);

  const photos = join(hexDir, "state", "iikb", "photos");

  expect(delivered).toMatchObject([
    [
      "-100:5",
      "Desk",
      {
        content: "the new icon",
        key: "iikb-m5",
        author: "owner",
        meta: {
          user: "iikb",
          image_path: `${join(photos, "m5-0.jpg")}; ${join(photos, "m5-1.png")}`,
          image_dimensions: "1600x1200; ",
        },
      },
    ],
  ]);
  expect(Buffer.from(await Bun.file(join(photos, "m5-0.jpg")).arrayBuffer())).toEqual(JPEG);
  expect(Buffer.from(await Bun.file(join(photos, "m5-1.png")).arrayBuffer())).toEqual(PNG);

  await post("/telegram%3A-100%3A5", {
    text: "",
    id: "m6",
    files: [{ type: "image/jpeg", data: jpeg }],
  });
  await post("/telegram%3A-100%3A5", {
    text: " ",
    id: "m7",
    files: [
      { type: "image/jpeg", data: jpeg },
      { type: "image/jpeg", data: jpeg },
    ],
  });

  expect(delivered.slice(1)).toMatchObject([
    ["-100:5", "Desk", { content: "(photo)" }],
    ["-100:5", "Desk", { content: "(album of 2)" }],
  ]);
});

test("a photo sent from the keyboard reads back in its chat under its caption, while it waits for its session too", async () => {
  const photo = join(hexDir, "state", "m8-0.jpg");
  const meta = { user: "iikb", image_path: photo, image_dimensions: "1600x1200" };

  writeFileSync(photo, "jpeg bytes");
  say(DESK, 1, "owner", "the new icon", meta);
  store.messages.deliver({
    key: "telegram:-100:5:2",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "(photo)",
    meta,
  });

  const shown = {
    name: "m8-0.jpg",
    type: "image/jpeg",
    width: 1600,
    height: 1200,
  };

  expect((await read(store, "telegram:-100:5")).messages).toEqual([
    {
      from: "me",
      text: "the new icon",
      files: [{ ...shown, url: "files/telegram%3A-100%3A5%3A1/0" }],
    },
    {
      from: "me",
      text: "",
      pending: true,
      files: [{ ...shown, url: "files/telegram%3A-100%3A5%3A2/0" }],
    },
  ]);
});

test("a chat whose app isn't running says so, a bad body is refused, and a wrong token gets nothing", async () => {
  expect((await post("/discord%3A7", { text: "hi", id: "m2" })).status).toBe(502);
  expect(
    (
      await post("/discord%3A7", {
        text: "",
        id: "m11",
        files: [{ type: "image/jpeg", data: JPEG.toString("base64") }],
      })
    ).status,
  ).toBe(502);
  expect(existsSync(join(hexDir, "state", "iikb", "photos", "m11-0.jpg"))).toBe(false);
  expect((await post("/telegram%3A-100%3A5", { text: " ", id: "m3" })).status).toBe(400);
  expect((await post("/telegram%3A-100%3A5", { text: "hi", id: "m4" }, "nope")).status).toBe(401);
  expect(
    (
      await post("/telegram%3A-100%3A5", {
        text: "",
        id: "m9",
        files: [{ type: "application/pdf", data: "cGRm" }],
      })
    ).status,
  ).toBe(400);
  expect((await post("/telegram%3A-100%3A5", { text: "hi", id: "../m10" })).status).toBe(400);

  for (const data of ["", PNG.toString("base64")]) {
    expect(
      (
        await post("/telegram%3A-100%3A5", {
          text: "",
          id: "m12",
          files: [{ type: "image/jpeg", data }],
        })
      ).status,
    ).toBe(400);
  }

  expect(delivered).toEqual([]);
});
