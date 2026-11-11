import { expect, test } from "bun:test";
import { join } from "node:path";

const GATE = join(import.meta.dir, "../../bin/send-gate");
const FORWARD = "mcp__claude_ai_Gmail__forward";
const MACHINES = "track@machine.example, inbox@other.example";

const gate = (tool_name: string, tool_input: object, machines = MACHINES) =>
  Bun.spawnSync([GATE], {
    env: { ...process.env, HEX_SEND_MACHINES: machines },
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name, tool_input, tool_use_id: "t1", transcript_path: "/nonexistent" }),
    ),
  })
    .stdout.toString()
    .includes('"deny"');

test("a forward or send whose every recipient is a listed machine goes without a yes", () => {
  expect(gate(FORWARD, { messageId: "m", to: ["Track@Machine.example"] })).toBe(false);
  expect(
    gate("mcp__claude_ai_Gmail__send_message", { to: ["track@machine.example"], cc: ["inbox@other.example"] }),
  ).toBe(false);
});

test.each([
  ["a person among the recipients", FORWARD, { to: ["track@machine.example"], cc: ["person@example.com"] }, MACHINES],
  ["a person in bcc", FORWARD, { to: ["track@machine.example"], bcc: ["person@example.com"] }, MACHINES],
  ["no recipients", FORWARD, { messageId: "m" }, MACHINES],
  ["no machines listed", FORWARD, { to: ["track@machine.example"] }, ""],
  ["a reply", "mcp__claude_ai_Gmail__reply", { to: ["track@machine.example"] }, MACHINES],
  ["a trash", "mcp__claude_ai_Gmail__trash_thread", { to: ["track@machine.example"] }, MACHINES],
])("%s still waits for a yes", (_, tool, input, machines) => {
  expect(gate(tool, input, machines)).toBe(true);
});

test("a call that isn't a send passes", () => {
  expect(gate("mcp__claude_ai_Gmail__search_threads", { query: "x" })).toBe(false);
});
