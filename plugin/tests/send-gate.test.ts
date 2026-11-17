import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../hooks/hooks.json";

const GATE = join(import.meta.dir, "../../bin/send-gate");
const FORWARD = "mcp__claude_ai_Gmail__forward";
const MACHINES = "track@machine.example, inbox@other.example";
const MAIL = `curl -sS -X POST "https://api.mail.example/v0/inboxes/me@mail.example/messages/send" -H "Content-Type: application/json" --data @mail.json`;

type Recipients = { to?: string[]; cc?: string[]; bcc?: string[] };

type Input = Recipients | { command: string };

const gate = (
  tool_name: string,
  tool_input: Input,
  { machines = MACHINES, transcript_path = "/nonexistent" } = {},
) =>
  Bun.spawnSync([GATE], {
    env: { ...process.env, HEX_SEND_MACHINES: machines },
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name, tool_input, tool_use_id: "t1", transcript_path }),
    ),
  })
    .stdout.toString()
    .includes('"deny"');

const folder = mkdtempSync(join(tmpdir(), "send-gate-"));
let transcripts = 0;

const said = (attributes: string, words: string) => ({
  type: "user",
  origin: { kind: "channel" },
  message: {
    role: "user",
    content: `<channel source="telegram" chat_id="1" ${attributes}>\n${words}\n</channel>`,
  },
});

const ran = (id: string, name: string, input: Input) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const transcript = (...lines: (ReturnType<typeof said> | ReturnType<typeof ran>)[]) => {
  const path = join(folder, `${transcripts++}.jsonl`);

  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));

  return path;
};

const bash = (command: string, transcript_path?: string) =>
  gate("Bash", { command }, { transcript_path });

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
  ["runs anything else", `git push origin main`],
])("a command that %s passes", (_, command) => {
  expect(bash(command)).toBe(false);
});

test("the owner's own yes lets one send through, and the next waits for another", () => {
  const yes = said('user="owner"', "yes");

  expect(bash(MAIL, transcript(yes))).toBe(false);
  expect(bash(MAIL, transcript(yes, ran("t0", "Bash", { command: MAIL })))).toBe(true);
  expect(bash(MAIL, transcript(yes, ran("t0", "Bash", { command: "ls" })))).toBe(false);
});

test("a pick hex answered on its own is not the owner's yes", () => {
  const picked = said('user="hex pick" button="true" answered_in="by hex, on its own pick"', "Yes");

  const voted = said(
    'user="hex pick" vote="Email support from hex&apos;s inbox (my pick)" answered_in="by hex, on its own pick"',
    "(vote: Email support from hex's inbox (my pick))",
  );

  expect(bash(MAIL, transcript(picked))).toBe(true);
  expect(bash(MAIL, transcript(voted))).toBe(true);
  expect(
    gate(FORWARD, { to: ["person@example.com"] }, { transcript_path: transcript(picked) }),
  ).toBe(true);
});

test("every session runs the gate before a command and a connector call", () => {
  const gates = plugin.hooks.PreToolUse.filter(({ hooks }) =>
    hooks.some(({ command }) => command.endsWith("/send-gate")),
  ).map(({ matcher }) => new RegExp(matcher, "u"));

  for (const tool of ["Bash", FORWARD]) {
    expect(gates.some((matcher) => matcher.test(tool))).toBe(true);
  }
});
