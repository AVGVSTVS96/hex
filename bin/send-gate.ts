#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { open, stateDir } from "../hub/store.ts";

const Addresses = z.array(z.string()).optional().catch(undefined);

const Input = z
  .object({
    command: z.string().optional().catch(undefined),
    to: Addresses,
    cc: Addresses,
    bcc: Addresses,
  })
  .catch({});

const Hook = z.object({
  tool_name: z.string(),
  tool_input: Input,
  tool_use_id: z.string().catch(""),
  transcript_path: z.string().catch(""),
});

type Call = { name: string; input: z.infer<typeof Input> };

const Line = z.object({
  message: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: Input }),
        z.object({ type: z.string() }),
      ]),
    ),
  }),
});

const CONNECTOR =
  /^mcp__claude_ai_[^_].*__((send|reply|forward|trash|delete)[a-z_]*|mark_[a-z_]*spam)$/u;

const RUN =
  /(^|[;&|]\s|[(\n]|\bssh\s[^;&|\n]*?\s['"]?|\s-c\s+['"])\s*(\w+=\S*\s+)*((time|exec|command|nohup)\s+)*(\S*\/)?/u
    .source;

const COMMAND = new RegExp(
  `${RUN}(pigeon\\s+send|sendmail|msmtp|himalaya\\b[^;&|\\n]*\\b(send|reply|forward)\\b|osascript\\b[^;&|\\n]*\\bMessages\\b[^;&|\\n]*\\bsend\\b)\\b` +
    `|https?://[^\\s"']*/((messages|mail|drafts)/send|messages/[^\\s"'/]+/(reply|reply-all|forward)|Messages\\.json)\\b`,
  "u",
);

const YES = /^(yes|yep|yeah|yup|sure|ok|okay|send it|do it|go ahead)[.!\s]*$/iu;

const HIS = new Set(["owner", "call"]);

const sends = ({ name, input }: Call) =>
  CONNECTOR.test(name) || (name === "Bash" && COMMAND.test(input.command ?? ""));

function toMachines({ name, input }: Call) {
  const machines = (process.env.HEX_SEND_MACHINES ?? "").toLowerCase().split(/[\s,]+/u);

  const recipients = [input.to, input.cc, input.bcc].flatMap((field) =>
    (field ?? []).map((address) => address.toLowerCase()),
  );

  return (
    /^mcp__.*__(send|forward)[a-z_]*$/u.test(name) &&
    recipients.length > 0 &&
    recipients.every((address) => machines.includes(address))
  );
}

function sentSince(line: string, id: string) {
  try {
    const content = Line.safeParse(JSON.parse(line)).data?.message.content ?? [];

    return content.some(
      (part) => "input" in part && part.id !== id && sends({ name: part.name, input: part.input }),
    );
  } catch {
    return false;
  }
}

function hisYes(id: string, transcript: string) {
  const thread = process.env.HEX_THREAD;

  if (thread === undefined || thread === "" || !existsSync(transcript)) {
    return false;
  }

  const said = open(stateDir()).messages.heard(thread);

  if (
    said === null ||
    !HIS.has(said.author) ||
    said.meta?.user === "hex pick" ||
    !YES.test(said.body.replace(/^\s*(<@[!&]?\d+>\s*)*/u, ""))
  ) {
    return false;
  }

  const lines = readFileSync(transcript, "utf-8").split("\n");

  const reached = lines.findLastIndex(
    (line) => line.includes(`key=\\"${said.key}\\"`) && !line.includes('"tool_result"'),
  );

  return reached !== -1 && !lines.slice(reached + 1).some((line) => sentSince(line, id));
}

const hook = Hook.parse(JSON.parse(await Bun.stdin.text()));
const call = { name: hook.tool_name, input: hook.tool_input };

if (sends(call) && !toMachines(call) && !hisYes(hook.tool_use_id, hook.transcript_path)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "A message to anyone but me, from my accounts or your own inbox, and sending, replying, forwarding, trashing, deleting or marking spam through a connector, needs my yes. Only my own words count: not a pick hex made, another session, a job or a schedule. Tell me in chat exactly what this call will do, wait for me to reply yes, then retry it. Each yes covers one call.",
      },
    }),
  );
}
