import { parseArgs } from "node:util";

import { commands, flagsOf, usage } from "./command.ts";
import type { Hex } from "./command.ts";
import { open } from "./store.ts";

const all = await commands();
const options = flagsOf(all);
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options });
const [state = "", name = "", ...args] = positionals;
const command = all.get(name);

const hex: Hex = {
  state,
  flags,
  args,
  usage: `usage:\n${[...all.values()]
    .flatMap((each) => each.usage.split("\n"))
    .map((line) => `  ${line}`)
    .join("\n")}`,
  get store() {
    return open(state);
  },
};

if (state === "" || name === "") {
  usage(hex);
}

for (const [flag, { short }] of Object.entries(options)) {
  if (short !== undefined && flags[flag] !== undefined && command?.flags?.[flag] === undefined) {
    const takers = [...all].filter(([, { flags: own }]) => own?.[flag] !== undefined);
    console.error(`hex: -${short} is only for ${takers.map(([taker]) => taker).join(", ")}`);
    process.exit(2);
  }
}

const unquotedValue = args[command?.wordsBeforeFlags?.(args) ?? 0];

if (unquotedValue !== undefined) {
  console.error(
    `hex: "${unquotedValue}" isn't a flag's value: quote every value that has spaces, like --title 'Fix the login page'`,
  );
  process.exit(1);
}

if (command === undefined) {
  usage(hex);
}

try {
  await command.run(hex);
} catch (error) {
  console.error(`hex: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
