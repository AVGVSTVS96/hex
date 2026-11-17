#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ROOM } from "../hub/fit.ts";
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

const section = (file: { path: string; text: string; kind: string }) =>
  `Contents of ${file.path} (${file.kind}):\n\n${file.text.trim()}`;

function rendered() {
  const all = files();

  return all.length ? [intro, ...all.map(section)].join("\n\n") : "";
}

function hookSizedPartsSplitAtLineEnds(text: string) {
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

if (import.meta.main) {
  const [command, flag] = process.argv.slice(2);

  if (command === "paths") {
    console.log(JSON.stringify(files().map((file) => file.path)));
  } else if (command === undefined || command === "") {
    console.log(rendered());
  } else if (isSet(process.env.HEX_THREAD) && isSet(process.env.HEX_FRESH)) {
    handToASubagentClaudeCodeSkippedThemFor(Number(command), flag === "last");
  }
}
