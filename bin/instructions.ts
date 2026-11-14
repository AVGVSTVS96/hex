#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { ROOM } from "../hub/fit.ts";
import { WAKE } from "../hub/loaded.ts";
import { loaded } from "./identity";

const home = resolve(import.meta.dir, "../..");
const isSet = (value?: string) => value !== undefined && value !== "";

const intro =
  "The user's instruction files are below. Follow them as written; they take precedence over default behavior.";

export const files = () => [
  ...loaded(join(homedir(), ".claude/CLAUDE.md")).map(([path, text]) => ({
    path,
    text,
    kind: "user's private global instructions for all projects",
  })),
  ...loaded(join(home, "AGENTS.md")).map(([path, text]) => ({
    path,
    text,
    kind: "project instructions, checked into the codebase",
  })),
];

export const briefedAgents = {
  "general-purpose": {
    description:
      "General-purpose agent for researching, searching and multi-step work. It starts from your brief and the instruction files, without your memory.",
    prompt:
      "You are a subagent of hex, my assistant: one of its sessions started you for one piece of its work, and its message is your brief. Do what it asks in full and check it, then report what you did and found in a few lines; that session reads your report and tells me. Your memory isn't loaded: work from your brief and your instruction files, which follow it, and leave `memo` to the session that started you.",
    omitClaudeMd: true,
  },
};

export const rules = () => Object.fromEntries(files().map((file) => [file.path, file.text]));

const section = (file: { path: string; text: string; kind: string }) =>
  `Contents of ${file.path} (${file.kind}):\n\n${file.text.trim()}`;

export function rendered() {
  const all = files();

  return all.length ? [intro, ...all.map(section)].join("\n\n") : "";
}

export function hold(dir: string) {
  const wake = join(home, WAKE);

  const memory = existsSync(wake)
    ? [{ path: wake, text: readFileSync(wake, "utf-8"), kind: "memory" }]
    : [];

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(join(dir, "seen"), { recursive: true, force: true });
  writeFileSync(join(dir, "CLAUDE.md"), `${[...files(), ...memory].map(section).join("\n\n")}\n`);
  writeFileSync(join(dir, "rules.json"), JSON.stringify(rules()));
  writeFileSync(join(dir, "wake.md"), memory[0]?.text ?? "");
}

export function hookSizedPartsSplitAtLineEnds(text: string) {
  const parts = [""];

  for (const line of text.split("\n")) {
    const current = parts.at(-1) ?? "";

    if (current !== "" && current.length + line.length + 1 > ROOM) {
      parts.push(`${line}\n`);
    } else {
      parts[parts.length - 1] = `${current}${line}\n`;
    }
  }

  return parts;
}

function handToASubagentClaudeCodeSkippedThemFor(n: number, last: boolean) {
  const all = hookSizedPartsSplitAtLineEnds(rendered());
  const part = all[n - 1] ?? "";

  if (part.trim() === "") {
    return;
  }

  const lead =
    all.length > 1
      ? `Your instruction files, part ${n} of ${all.length}; read the parts in order.`
      : "Your instruction files.";

  const more =
    last && all.length > n
      ? `\nThat's all the hooks can show. Read the files themselves and follow them: ${files()
          .map((file) => file.path)
          .join(", ")}.\n`
      : "";

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: `${lead}\n\n${part}${more}`,
      },
    }),
  );
}

const Starting = z.object({ agent_type: z.string().catch("") });

async function claudeCodeSkippedThemForTheStartingAgent() {
  const { agent_type } = Starting.parse(JSON.parse((await Bun.stdin.text()) || "{}"));

  return isSet(process.env.HEX_FRESH) || agent_type in briefedAgents;
}

if (import.meta.main) {
  const [command, flag] = process.argv.slice(2);

  if (command === "paths") {
    console.log(JSON.stringify(files().map((file) => file.path)));
  } else if (command === "agents") {
    console.log(JSON.stringify(briefedAgents));
  } else if (command === "hold") {
    if (flag === undefined) {
      throw new Error("instructions hold <dir>");
    }

    hold(flag);
  } else if (command === undefined || command === "") {
    console.log(rendered());
  } else if (isSet(process.env.HEX_THREAD) && (await claudeCodeSkippedThemForTheStartingAgent())) {
    handToASubagentClaudeCodeSkippedThemFor(Number(command), flag === "last");
  }
}
