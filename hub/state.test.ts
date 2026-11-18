import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { file } from "./store.ts";
import { until } from "./until.ts";

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

const Owed = z.object({
  type: z.literal("owed"),
  thread: z.literal("dm"),
  said: z.array(z.object({ row: z.looseObject({ key: z.string() }), by: z.string() })),
});

const Blocked = z.object({ decision: z.literal("block"), reason: z.string() });

async function hook(step: "busy" | "idle", input: Input, env: Record<string, string> = {}) {
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
      ...env,
    },
  });

  expect(await run.exited).toBe(0);

  return (await new Response(run.stdout).text()).trim();
}

function said(key: string, body: string) {
  file(dir).messages.deliver({ key, to: "dm", from: "telegram", author: "owner", body });

  return hook("busy", { hook_event_name: "UserPromptSubmit", prompt: tag(key, body) });
}

function replied(key: string) {
  file(dir).messages.deliver(
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
  expect(file(dir).turns.atWork("s")).toBe(true);

  replied("telegram:dm:982");
  expect(await stop({ stop_hook_active: true })).toBe("");
  expect(file(dir).turns.atWork("s")).toBe(false);
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
  file(dir).messages.deliver({
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

test("what a session's hooks can't keep while hex's store is unreachable goes to its hub, which keeps it once the store answers", async () => {
  writeFileSync(
    join(dir, "store.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", name: "gone", key: "k".repeat(32) }),
  );
  const lines: string[] = [];

  const hub = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
    });
    socket.on("end", () => {
      lines.push(...text.trim().split("\n"));
    });
  }).listen(join(dir, "hub.sock"));

  try {
    const atTheHub = { HEX_HUB: join(dir, "hub.sock") };
    await hook("busy", { hook_event_name: "UserPromptSubmit", prompt: "typed here" }, atTheHub);
    await hook("idle", { hook_event_name: "Stop", last_assistant_message: "Done." }, atTheHub);
    await until(() => lines.length === 4);

    const owed = lines.flatMap((line) => Owed.safeParse(JSON.parse(line)).data?.said ?? []);

    expect(
      owed.map(({ row: { key, at, ...row }, by }) => [
        key.startsWith("terminal:") &&
          (z.string().safeParse(at).data ?? "9") <= new Date().toISOString(),
        row,
        by,
      ]),
    ).toEqual([
      [
        true,
        { to: "dm", from: "terminal", author: "owner", body: "typed here", meta: { session: "s" } },
        "s",
      ],
      [
        true,
        {
          to: "dm",
          from: "terminal",
          author: "hex",
          body: "Done.",
          meta: { session: "s", unsent: "true" },
        },
        "s",
      ],
    ]);
  } finally {
    hub.close();
  }
});

test("a tool call doesn't wait on a store that's down to give the words held for its turn", async () => {
  writeFileSync(
    join(dir, "store.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", name: "gone", key: "k".repeat(32) }),
  );
  const began = Date.now();

  const run = Bun.spawn([process.execPath, join(import.meta.dir, "held.ts")], {
    stdin: new Blob([JSON.stringify({ session_id: "s", hook_event_name: "PostToolUse" })]),
    env: { ...process.env, HEX_STORE: dir, HEX_THREAD: "dm", HEX_HUB: "" },
  });

  expect(await run.exited).toBe(0);
  expect(Date.now() - began).toBeLessThan(1500);
});
