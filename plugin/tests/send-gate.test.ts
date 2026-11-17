import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../../hub/store.ts";
import type { Author } from "../../hub/store/messages.ts";
import plugin from "../hooks/hooks.json";

const GATE = join(import.meta.dir, "../../bin/send-gate");
const FORWARD = "mcp__claude_ai_Gmail__forward";
const MACHINES = "track@machine.example, inbox@other.example";
const MAIL = `curl -sS -X POST "https://api.mail.example/v0/inboxes/me@mail.example/messages/send" -H "Content-Type: application/json" --data @mail.json`;

type Recipients = { to?: string[]; cc?: string[]; bcc?: string[] };

type Input = Recipients | { command: string };

const folder = mkdtempSync(join(tmpdir(), "send-gate-"));
const state = join(folder, "state");
const store = open(state);
let made = 0;

const gate = (
  tool_name: string,
  tool_input: Input,
  { machines = MACHINES, transcript_path = "/nonexistent", thread = "nowhere" } = {},
) =>
  Bun.spawnSync([GATE], {
    env: { ...process.env, HEX_SEND_MACHINES: machines, HEX_STORE: state, HEX_THREAD: thread },
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name, tool_input, tool_use_id: "t1", transcript_path }),
    ),
  })
    .stdout.toString()
    .includes('"deny"');

const ran = (id: string, name: string, input: Input) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const block = (key: string, user: string, body: string) =>
  `<channel source="telegram" key="${key}" chat_id="1" user="${user}">\n${body}\n</channel>`;

const shown = (key: string, user: string, body: string) => ({
  type: "user",
  origin: { kind: "channel" },
  message: { role: "user", content: block(key, user, body) },
});

const heldOver = (key: string, user: string, body: string) => ({
  type: "attachment",
  attachment: {
    type: "hook_additional_context",
    content: [`The user sent a new message while you were working:\n${block(key, user, body)}`],
  },
});

type Said = {
  author: Author;
  user: string;
  body: string;
  seen?: typeof shown | typeof heldOver | null;
};

function inThread(...said: Said[]) {
  const id = `thread-${made++}`;

  const lines = said.flatMap(({ author, user, body, seen = shown }) => {
    const key = `telegram:${id}:${made++}`;

    store.messages.deliver({ key, to: id, from: "telegram", author, body, meta: { user } });

    return seen === null ? [] : [seen(key, user, body)];
  });

  const write = (...after: ReturnType<typeof ran>[]) => {
    const path = join(folder, `${made++}.jsonl`);

    writeFileSync(path, [...lines, ...after].map((line) => JSON.stringify(line)).join("\n"));

    return path;
  };

  return {
    send: (command = MAIL, ...after: ReturnType<typeof ran>[]) =>
      gate("Bash", { command }, { thread: id, transcript_path: write(...after) }),
    forward: (input: Recipients) => gate(FORWARD, input, { thread: id, transcript_path: write() }),
  };
}

const his = (body: string, more: Partial<Said> = {}): Said => ({
  author: "owner",
  user: "owner",
  body,
  ...more,
});

const bash = (command: string) => gate("Bash", { command });

test("a forward or send whose every recipient is a listed machine goes without a yes", () => {
  expect(gate(FORWARD, { to: ["Track@Machine.example"] })).toBe(false);
  expect(
    gate("mcp__claude_ai_Gmail__send_message", {
      to: ["track@machine.example"],
      cc: ["inbox@other.example"],
    }),
  ).toBe(false);
});

test.each([
  [
    "a person among the recipients",
    FORWARD,
    { to: ["track@machine.example"], cc: ["person@example.com"] },
    MACHINES,
  ],
  [
    "a person in bcc",
    FORWARD,
    { to: ["track@machine.example"], bcc: ["person@example.com"] },
    MACHINES,
  ],
  ["no recipients", FORWARD, {}, MACHINES],
  ["no machines listed", FORWARD, { to: ["track@machine.example"] }, ""],
  ["a reply", "mcp__claude_ai_Gmail__reply", { to: ["track@machine.example"] }, MACHINES],
  ["a trash", "mcp__claude_ai_Gmail__trash_thread", { to: ["track@machine.example"] }, MACHINES],
])("%s still waits for a yes", (_, tool, input, machines) => {
  expect(gate(tool, input, { machines })).toBe(true);
});

test("a call that isn't a send passes", () => {
  expect(gate("mcp__claude_ai_Gmail__search_threads", {})).toBe(false);
});

test.each([
  ["mail through an inbox's API", MAIL],
  ["a reply through an inbox's API", `curl -X POST https://api.mail.example/v0/messages/m1/reply`],
  [
    "through Gmail's API",
    `curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
  ],
  [
    "a text through Twilio",
    `curl -X POST https://api.twilio.com/2010-04-01/Accounts/A/Messages.json`,
  ],
  ["an iMessage over ssh", `ssh mac 'pigeon send +15550100 "on my way"'`],
  ["an iMessage over ssh with options", `ssh -o ConnectTimeout=8 mac pigeon send +15550100 hi`],
  [
    "an iMessage after a setup",
    `ssh mac 'export PATH=$HOME/bin:$PATH; time pigeon send +15550100 hi'`,
  ],
  [
    "an iMessage by AppleScript",
    `osascript -e 'tell application "Messages" to send "hi" to buddy "x"'`,
  ],
  ["from a mail client", `himalaya message send < mail.eml`],
  ["with sendmail", `printf 'Subject: hi\\n' | sendmail person@example.com`],
])("sending %s waits for a yes", (_, command) => {
  expect(bash(command)).toBe(true);
});

test.each([
  ["reads an inbox", `curl -sS https://api.mail.example/v0/inboxes/me@mail.example/messages`],
  ["reads iMessages", `ssh mac 'pigeon read +15550100'`],
  ["searches for how mail was sent", `hex log | rg -n "api.mail.example|inboxes/.*/messages/send"`],
  ["searches for a mail command", `rg -n 'sendmail|pigeon send' bin`],
  ["commits a message that names one", `git commit -m "fix: pigeon send waits for a yes"`],
  ["runs anything else", `git push origin main`],
])("a command that %s passes", (_, command) => {
  expect(bash(command)).toBe(false);
});

test("the owner's own yes lets one send through, and the next waits for another", () => {
  expect(inThread(his("yes")).send()).toBe(false);
  expect(inThread(his("Go ahead.")).send()).toBe(false);
  expect(inThread(his("yes")).send(MAIL, ran("t0", "Bash", { command: MAIL }))).toBe(true);
  expect(inThread(his("yes")).send(MAIL, ran("t0", "Bash", { command: "ls" }))).toBe(false);
  expect(inThread(his("yes")).forward({ to: ["person@example.com"] })).toBe(false);
});

test("the owner's yes counts when it reached the session mid-turn, or on a call", () => {
  expect(inThread(his("yes", { seen: heldOver })).send()).toBe(false);
  expect(inThread(his("yes", { author: "call", user: "" })).send()).toBe(false);
});

test.each([
  ["another hex session", { author: "prompt", user: "hex General", body: "go ahead" }],
  ["a job", { author: "prompt", user: "job", body: "ok" }],
  ["a schedule", { author: "prompt", user: "schedule", body: "yes" }],
  ["a page relaying a tap", { author: "prompt", user: "Bassim, on the fixes page", body: "yes" }],
  ["someone else in a shared channel", { author: "other", user: "guest", body: "yes" }],
  ["a pick hex made itself", { author: "owner", user: "hex pick", body: "Yes" }],
] satisfies [string, Said][])("a yes from %s isn't the owner's", (_, said) => {
  expect(inThread(said).send()).toBe(true);
  expect(inThread(said).forward({ to: ["person@example.com"] })).toBe(true);
});

test("a yes counts only while it is the thread's latest word and reached this session", () => {
  expect(inThread(his("yes"), { author: "prompt", user: "job", body: "[job] ended" }).send()).toBe(
    true,
  );
  expect(inThread(his("yes", { seen: null })).send()).toBe(true);
  expect(inThread(his("send the email to support")).send()).toBe(true);
  expect(inThread().send()).toBe(true);
});

test("every session runs the gate before a command and a connector call", () => {
  const gates = plugin.hooks.PreToolUse.filter(({ hooks }) =>
    hooks.some(({ command }) => command.endsWith("/send-gate")),
  ).map(({ matcher }) => new RegExp(matcher, "u"));

  for (const tool of ["Bash", FORWARD]) {
    expect(gates.some((matcher) => matcher.test(tool))).toBe(true);
  }
});
