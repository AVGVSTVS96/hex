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
  prompted("schedule:catch-up@1", "beside:general", "catch-1", "catch-up");
  wrote("telegram:2", "A job ended", "catch-1");
  prompted("schedule:heartbeat@2", "beside:general", "beat-2");

  const shown = said(
    store,
    "general",
    "beat-2",
    '<channel source="telegram" key="schedule:heartbeat@2" user="schedule">\n[heartbeat] Hourly check\n</channel>',
  );

  expect(shown).toContain(
    "What earlier runs of [heartbeat] said in this chat, so you don't tell the owner again:\n- ",
  );
  expect(shown.split("What earlier runs")[1]).toContain("The landlord wrote about the lease");
  expect(shown.split("What earlier runs")[1]).not.toContain("A job ended");
});
