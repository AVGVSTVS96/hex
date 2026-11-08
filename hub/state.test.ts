import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { open } from "./store.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tag = (key: string, body: string) =>
  `<channel source="plugin:telegram:telegram" key="${key}" user="owner">\n${body}\n</channel>`;

type Input = Record<string, string | boolean>;

const Blocked = z.object({ decision: z.literal("block"), reason: z.string() });

async function hook(step: "busy" | "idle", input: Input) {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, "state.ts"), step], {
    stdin: new Blob([JSON.stringify({ session_id: "s", ...input })]),
    stdout: "pipe",
    env: {
      ...process.env,
      HEX_STORE: dir,
      HEX_THREAD: "dm",
      HEX_CHANNEL: "plugin:telegram@hex",
      HEX_HUB: "",
      MEMORY_DIR: "",
    },
  });

  expect(await run.exited).toBe(0);

  return (await new Response(run.stdout).text()).trim();
}

function said(key: string, body: string) {
  open(dir).messages.deliver({ key, to: "dm", from: "telegram", author: "owner", body });

  return hook("busy", { hook_event_name: "UserPromptSubmit", prompt: tag(key, body) });
}

function replied(key: string) {
  open(dir).messages.deliver(
    { key, to: "dm", from: "telegram", author: "hex", body: "Fixed." },
    "s",
  );
}

const stop = (input: Input = {}) =>
  hook("idle", { hook_event_name: "Stop", last_assistant_message: "Done.", ...input });

test("a turn that took a second message mid-turn and replied once doesn't end until it answers", async () => {
  await said("telegram:dm:980", "fix the wrong line in the design spec");
  await said("telegram:app-1", "what's the server's uptime?");
  replied("telegram:dm:981");

  const blocked = Blocked.parse(JSON.parse(await stop()));
  expect(blocked.reason).toContain("telegram:app-1: what's the server's uptime?");
  expect(blocked.reason).toContain("telegram:dm:980");
  expect(open(dir).turns.atWork("s")).toBe(true);

  replied("telegram:dm:982");
  expect(await stop({ stop_hook_active: true })).toBe("");
  expect(open(dir).turns.atWork("s")).toBe(false);
});

test("a turn ends as it is once each message has a reply, and the next turn counts from there", async () => {
  await said("telegram:dm:1", "how's the build?");
  replied("telegram:dm:2");
  expect(await stop()).toBe("");

  await said("telegram:dm:3", "and the install?");
  await said("telegram:dm:4", "and the iPad?");
  replied("telegram:dm:5");
  replied("telegram:dm:6");
  expect(await stop()).toBe("");
});

test("a reaction mid-turn asks for no reply", async () => {
  await said("telegram:dm:1", "how's the build?");
  open(dir).messages.deliver({
    key: "telegram:dm:2",
    to: "dm",
    from: "telegram",
    author: "owner",
    body: "(reaction: 👍)",
    meta: { reaction: "👍" },
  });
  await hook("busy", {
    hook_event_name: "UserPromptSubmit",
    prompt: tag("telegram:dm:2", "(reaction: 👍)"),
  });
  replied("telegram:dm:3");
  expect(await stop()).toBe("");
});
