import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { said } from "./said.ts";
import { open } from "./store.ts";
import type { Store } from "./store.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "said-"));
  store = open(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const prompted = (key: string, to: string, by: string, schedule = "heartbeat") => {
  store.messages.deliver({
    key,
    to,
    from: "schedule",
    author: "prompt",
    body: `[${schedule}] Hourly check`,
    meta: { user: "schedule", schedule },
  });
  store.messages.take(key, by);
};

const wrote = (key: string, body: string, by: string, to = "general") => {
  store.messages.deliver({ key, to, from: "telegram", author: "hex", body, meta: {} }, by);
};

test("General is shown what a session beside it told the owner since its last turn, once", () => {
  prompted("schedule:heartbeat@1", "beside:general", "beat-1");
  wrote("telegram:1", "The landlord wrote about the lease: https://mail.example/1", "beat-1");
  wrote("telegram:2", "On it.", "general-session");

  const first = said(store, "general", "general-session");
  expect(first).toContain("[heartbeat]: The landlord wrote about the lease");
  expect(first).not.toContain("On it.");
  expect(said(store, "general", "general-session")).toBe("");
});

test("a timed job's run beside a thread is shown what its earlier runs said there, so it says nothing twice", () => {
  prompted("schedule:heartbeat@1", "beside:general", "beat-1");
  wrote("telegram:1", "The landlord wrote about the lease", "beat-1");
  Bun.sleepSync(2);
  prompted("schedule:catch-up@1", "beside:general", "catch-1", "catch-up");
  wrote("telegram:2", "A job ended", "catch-1");
  prompted("schedule:heartbeat@2", "beside:general", "beat-2");

  const shown = said(
    store,
    "general",
    "beat-2",
    '<channel source="telegram" key="schedule:heartbeat@2" user="schedule">\n[heartbeat] Hourly check\n</channel>',
  );

  const [others = "", earlier = ""] = shown.split("What earlier runs of [heartbeat]");
  expect(earlier).toContain("The landlord wrote about the lease");
  expect(earlier).not.toContain("A job ended");
  expect(others).toContain("[catch-up]: A job ended");
  expect(others).not.toContain("The landlord");
});

test("an earlier run that said nothing leaves its last words for the next, and a message shows whole", () => {
  prompted("schedule:heartbeat@1", "beside:general", "beat-1");
  wrote("telegram:1", "**Catch-up**\n- mail: 2 new\n- jobs: none", "beat-1");
  store.messages.deliver(
    {
      key: "terminal:1",
      to: "beat-1",
      from: "terminal",
      author: "hex",
      body: "Looked at mail and jobs: nothing new.",
      meta: { unsent: "true" },
    },
    "beat-1",
  );
  prompted("schedule:heartbeat@2", "beside:general", "beat-2");

  const shown = said(
    store,
    "general",
    "beat-2",
    '<channel source="telegram" key="schedule:heartbeat@2">',
  );

  expect(shown).toContain("**Catch-up**\n  - mail: 2 new\n  - jobs: none");
  expect(shown).toContain("(its last words, not sent): Looked at mail and jobs: nothing new.");
});

test("a new session isn't shown its own thread's earlier sessions as others", () => {
  store.messages.deliver(
    { key: "telegram:9", to: "general", from: "telegram", author: "owner", body: "hi", meta: {} },
    "general-before",
  );
  wrote("telegram:10", "Hello.", "general-before");

  expect(said(store, "general", "general-after")).toBe("");
});

test("a new session is shown only what came since its job last ran, or since its thread's own sessions last took a message", () => {
  prompted("schedule:heartbeat@1", "beside:general", "beat-1");
  wrote("telegram:1", "Old news from long ago", "beat-1");
  store.messages.deliver({
    key: "telegram:2",
    to: "general",
    from: "telegram",
    author: "owner",
    body: "Thanks",
    meta: {},
  });
  store.messages.take("telegram:2", "general-1");
  Bun.sleepSync(2);
  wrote("telegram:3", "The build finished", "beat-1");
  Bun.sleepSync(2);
  prompted("schedule:once@1", "beside:general", "once-1", "once");

  expect(
    said(
      store,
      "general",
      "once-1",
      '<channel source="telegram" key="schedule:once@1" user="schedule">\n[once] Hourly check\n</channel>',
    ),
  ).toBe("");

  const fresh = said(store, "general", "general-2");
  expect(fresh).toContain("since this chat's last turn");
  expect(fresh).toContain("The build finished");
  expect(fresh).not.toContain("Old news");
});

test("what a job's report run said is named for the job", () => {
  store.messages.deliver({
    key: "job:mail@1",
    to: "beside:general",
    from: "job",
    author: "prompt",
    body: "[job] mail ended",
    meta: { user: "job", job: "mail" },
  });
  store.messages.take("job:mail@1", "report-1");
  wrote("telegram:1", "Two new mails", "report-1");

  expect(said(store, "general", "general-session")).toContain("[mail]: Two new mails");
});
