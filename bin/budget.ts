#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { z } from "zod";

import { loaded } from "./identity";

const Edit = z.object({
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const Hook = z.object({
  tool_name: z.string(),
  tool_input: z
    .object({
      command: z.string().optional(),
      file_path: z.string().optional(),
      content: z.string().optional(),
      edits: z.array(Edit).optional(),
    })
    .loose()
    .optional(),
});

const home = resolve(import.meta.dir, "../..");
const wordsSet = process.env.HEX_RULES_WORDS;
const budget = Number(wordsSet === undefined || wordsSet === "" ? 2500 : wordsSet);

const real = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
};

const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
const hex = `${real(join(home, ".hex"))}/`;
const readFile = (file: string) => readFileSync(file, "utf-8");

const rulesInEveryPromptOutsideHex = (read?: (file: string) => string) =>
  loaded(join(home, "AGENTS.md"), new Set(), 0, read).filter(
    ([file]) => !real(file).startsWith(hex),
  );

const total = (files: [string, string][]) => {
  let sum = 0;

  for (const [, text] of files) {
    sum += words(text);
  }

  return sum;
};

const names = (files: [string, string][]) =>
  new Intl.ListFormat("en").format(files.map(([file]) => relative(home, file)));

const workItInOrPayWithACut = `Work the change into the line it belongs to, or cut words that say less, so they stay within ${budget}.`;

function replace(text: string, { old_string, new_string, replace_all }: z.infer<typeof Edit>) {
  if (replace_all === true) {
    return text.split(old_string).join(new_string);
  }

  const at = text.indexOf(old_string);

  return at === -1 ? text : text.slice(0, at) + new_string + text.slice(at + old_string.length);
}

const { tool_name, tool_input } = Hook.parse(JSON.parse(readFileSync(0, "utf-8")));
const before = rulesInEveryPromptOutsideHex();
const now = total(before);

if (tool_name === "Bash") {
  const touched = before.some(([file]) =>
    (tool_input?.command ?? "").includes(relative(home, file)),
  );

  if (touched && now > budget) {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: `${names(before)} are now ${now} words, over the ${budget} set by HEX_RULES_WORDS. ${workItInOrPayWithACut}`,
      }),
    );
  }
} else {
  const target = real(resolve(home, tool_input?.file_path ?? ""));

  const proposed = (file: string) => {
    if (tool_name === "Write") {
      return tool_input?.content ?? "";
    }

    let text = readFile(file);

    for (const edit of tool_input?.edits ?? [Edit.parse(tool_input)]) {
      text = replace(text, edit);
    }

    return text;
  };

  const after = rulesInEveryPromptOutsideHex((file) =>
    real(file) === target ? proposed(file) : readFile(file),
  );

  const size = total(after);

  if (size > budget && size > now) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `This edit takes ${names(after)} from ${now} to ${size} words, over the ${budget} set by HEX_RULES_WORDS. ${workItInOrPayWithACut}`,
        },
      }),
    );
  }
}
