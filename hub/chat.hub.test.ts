import { expect, test } from "bun:test";

import { history } from "./chat.ts";
import { SESSION, dir, stored } from "./hub.testing.ts";
import { file } from "./store.ts";

test("a thread's history is what the owner said and hex replied, headings and all, without the terminal, others, failed sends or what waits, and a session's is what it took", async () => {
  stored([
    { author: "owner", body: "how full is your context?" },
    { author: "hex", body: "Roomy.\n\n## What loads\n\nthe rules" },
    { author: "owner", from: "terminal", body: "typed in the terminal" },
    { author: "hex", body: "never sent", meta: { failed: "network" } },
    { author: "owner", from: "telegram", body: "thanks" },
    {
      author: "prompt",
      from: "telegram",
      body: "From General: the build passed.",
      meta: { user: "hex General" },
    },
    { author: "call", from: "voice", body: "[1.0s] you: hi\n[2.0s] voice: hello" },
  ]);
  stored([{ author: "owner", body: "not taken yet" }], "chat:7", undefined);
  stored([{ author: "owner", body: "another thread" }], "chat:8");
  expect(await history(file(dir).store, "chat:7")).toEqual([
    { from: "me", text: "how full is your context?" },
    { from: "hex", text: "Roomy.\n\n## What loads\n\nthe rules" },
    { from: "me", text: "thanks" },
  ]);
  expect(await history(file(dir).store, "chat:9")).toEqual([]);
  file(dir)
    .db.query("update messages set at = '2026-10-01T00:00:00.000Z' where key = 'buzz:chat:7-0'")
    .run();
  file(dir)
    .db.query("update messages set taken_by = 'older-session' where key = 'buzz:chat:7-0'")
    .run();
  expect((await history(file(dir).store, "chat:7", SESSION)).map((turn) => turn.text)).toEqual([
    "Roomy.\n\n## What loads\n\nthe rules",
    "thanks",
  ]);
  expect(await history(file(dir).store, "chat:7", "new-session")).toEqual([]);
});

test("a T3 message in a history is the owner's request, without the context T3 Code sends around it", async () => {
  const runtime = "<runtime_info>In case you're asked: you are running in T3 Code.</runtime_info>";
  stored([
    {
      author: "owner",
      from: "t3",
      body: `<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer assumptions.\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n${runtime}`,
    },
    {
      author: "owner",
      from: "t3",
      body: `and the docs\n\n${runtime}\n\n<pull_request_linking>\nLink every PR.\n</pull_request_linking>`,
    },
    { author: "hex", from: "t3", body: "Shipped." },
  ]);
  expect(await history(file(dir).store, "chat:7")).toEqual([
    { from: "me", text: "ship it" },
    { from: "me", text: "and the docs" },
    { from: "hex", text: "Shipped." },
  ]);
});
