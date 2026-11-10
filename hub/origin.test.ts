import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { open } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "origin-"));
  mkdirSync(join(dir, "telegram"));
  const store = open(dir);
  store.threads.keep("telegram", { "-100:7": { name: "Website" }, "-100:8": { name: "Shop" } });
  store.threads.keep("voice", { voice: { name: "voice" } });
  store.messages.deliver({
    key: "voice:c1:1",
    to: "voice",
    from: "voice",
    body: "[1.2s] you: Check the build.\n[2.0s] voice: On it.",
    author: "call",
  });
  store.messages.take("voice:c1:1", "v");
  store.messages.deliver({
    key: "telegram:-100:50",
    to: "-100:7",
    from: "telegram",
    body: "Fix the login page.",
    author: "owner",
    meta: { user: "victor" },
  });
  store.messages.take("telegram:-100:50", "s");
  store.messages.deliver({
    key: "telegram:-100:51",
    to: "-100:7",
    from: "telegram",
    body: "On it.",
    author: "hex",
  });
  store.messages.deliver({
    key: "telegram:-100:51+👍",
    to: "-100:7",
    from: "telegram",
    body: "(reaction: 👍)",
    author: "owner",
    meta: { user: "victor", reaction: "👍" },
  });
  store.messages.take("telegram:-100:51+👍", "s");
  store.messages.deliver({
    key: "telegram:-100:52",
    to: "-100:7",
    from: "telegram",
    body: "Also the signup page.",
    author: "owner",
    meta: { user: "victor" },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HookOutput = z.object({
  hookSpecificOutput: z.object({ hookEventName: z.string(), additionalContext: z.string() }),
});

async function hook(event: string, env: Record<string, string>) {
  const run = Bun.spawn(["bun", join(import.meta.dir, "origin.ts")], {
    stdin: new Blob([JSON.stringify({ hook_event_name: event, session_id: "s" })]),
    stdout: "pipe",
    env: { PATH: process.env.PATH ?? "", HEX_STORE: dir, ...env },
  });

  expect(await run.exited).toBe(0);

  const out = await new Response(run.stdout).text();

  return out === "" ? undefined : HookOutput.parse(JSON.parse(out)).hookSpecificOutput;
}

test("a subagent of a thread's session is told the conversation it works for and the owner's newest message its session took, past reactions", async () => {
  const told = await hook("SubagentStart", {
    HEX_CHANNEL: "plugin:telegram@hex",
    HEX_THREAD: "-100:7",
  });

  expect(told?.hookEventName).toBe("SubagentStart");
  expect(told?.additionalContext).toContain("in Website: `");
  expect(told?.additionalContext).toContain("/bin/hex log --last 100 -- '-100:7'`");
  expect(told?.additionalContext).toContain("/bin/hex message telegram:-100:50`");
});

test("a job's session is told where its work came from, and the thread's own session isn't told its own thread", async () => {
  const job = await hook("SessionStart", {
    HEX_OWNER: "telegram:-100:7",
    HEX_FROM: "telegram:-100:7",
  });

  expect(job?.hookEventName).toBe("SessionStart");
  expect(job?.additionalContext).toContain("/bin/hex message telegram:-100:50`");
  expect(job?.additionalContext).toStartWith("You are a job, so your memory isn't loaded");
  expect(
    await hook("SessionStart", { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:7" }),
  ).toBeUndefined();
  expect(await hook("SubagentStart", {})).toBeUndefined();
});

test("a job started for another thread is told the conversation that started it", async () => {
  const job = await hook("SessionStart", {
    HEX_OWNER: "telegram:-100:8",
    HEX_FROM: "telegram:-100:7",
  });

  expect(job?.additionalContext).toContain("in Website: `");
  expect(job?.additionalContext).toContain("/bin/hex message telegram:-100:50`");
});

test("what the owner said on a call counts as their words, and a thread with none still gets its conversation", async () => {
  expect(
    (await hook("SubagentStart", { HEX_CHANNEL: "plugin:voice@hex", HEX_THREAD: "voice" }))
      ?.additionalContext,
  ).toContain("/bin/hex message voice:c1:1`");

  const told = await hook("SubagentStart", {
    HEX_CHANNEL: "plugin:telegram@hex",
    HEX_THREAD: "-100:8",
  });

  expect(told?.additionalContext).toEndWith(
    "/bin/hex log --last 100 -- '-100:8'` prints its newest 100 messages (without --last, all of it).",
  );
});

test("a thread's own session goes by its thread over job variables it inherited, and a thread hex doesn't have gets nothing", async () => {
  expect(
    await hook("SessionStart", {
      HEX_CHANNEL: "plugin:telegram@hex",
      HEX_THREAD: "-100:8",
      HEX_OWNER: "telegram:-100:7",
      HEX_FROM: "telegram:-100:7",
    }),
  ).toBeUndefined();
  expect(
    (
      await hook("SubagentStart", {
        HEX_CHANNEL: "plugin:telegram@hex",
        HEX_THREAD: "-100:8",
        HEX_FROM: "telegram:-100:7",
      })
    )?.additionalContext,
  ).toContain("in Shop: `");
  expect(await hook("SubagentStart", { HEX_OWNER: "telegram:-100:99" })).toBeUndefined();
});

test("a job is told the owner's words as they were when it started, a job no conversation started only that it is one, and a vote taken off isn't the owner's words", async () => {
  const store = open(dir);
  store.messages.deliver({
    key: "telegram:-100:52b",
    to: "-100:7",
    from: "telegram",
    body: "A follow-up sent mid-turn.",
    author: "owner",
    meta: { user: "victor" },
  });
  await Bun.sleep(5);
  const started = new Date().toISOString();
  await Bun.sleep(5);
  store.messages.take("telegram:-100:52b", "s");
  store.messages.deliver({
    key: "telegram:-100:53",
    to: "-100:7",
    from: "telegram",
    body: "(vote removed)",
    author: "owner",
    meta: { vote_removed: "true" },
  });
  store.messages.take("telegram:-100:53", "s");
  expect(
    (await hook("SubagentStart", { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:7" }))
      ?.additionalContext,
  ).toContain("/bin/hex message telegram:-100:52b`");
  store.messages.deliver({
    key: "telegram:-100:54",
    to: "-100:7",
    from: "telegram",
    body: "Something else now.",
    author: "owner",
    meta: { user: "victor" },
  });
  store.messages.take("telegram:-100:54", "s");
  expect(
    (await hook("SubagentStart", { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:7" }))
      ?.additionalContext,
  ).toContain("/bin/hex message telegram:-100:54`");
  expect(
    (
      await hook("SubagentStart", {
        HEX_OWNER: "telegram:-100:7",
        HEX_FROM: "telegram:-100:7",
        HEX_FROM_AT: started,
      })
    )?.additionalContext,
  ).toContain("/bin/hex message telegram:-100:50`");
  expect(
    (await hook("SessionStart", { HEX_OWNER: "telegram:-100:7" }))?.additionalContext,
  ).toEndWith("leave `memo` to the session that started you.");
});

test("an edit is named by the message it edits, so the line reads as the owner's newest words however often they edit", async () => {
  const store = open(dir);
  store.messages.take("telegram:-100:52", "s");
  store.messages.deliver({
    key: "telegram:-100:52@1",
    to: "-100:7",
    from: "telegram",
    body: "Also the signup page, today.",
    author: "owner",
    meta: { user: "victor", edited: "true", message_id: "52" },
  });
  store.messages.take("telegram:-100:52@1", "s");
  expect(
    (await hook("SubagentStart", { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:7" }))
      ?.additionalContext,
  ).toContain("/bin/hex message telegram:-100:52`");
  store.messages.deliver({
    key: "telegram:-100:52@2",
    to: "-100:7",
    from: "telegram",
    body: "Also the signup page, tonight.",
    author: "owner",
    meta: { user: "victor", edited: "true", message_id: "52" },
  });

  const cli = Bun.spawn(
    ["bun", join(import.meta.dir, "cli.ts"), dir, "message", "telegram:-100:52"],
    { stdout: "pipe" },
  );

  expect(await cli.exited).toBe(0);
  expect((await new Response(cli.stdout).text()).trim()).toBe("Also the signup page, tonight.");
});
