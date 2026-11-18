import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import type { Command, Hex } from "./command.ts";
import { open } from "./store.ts";

const folder = join(import.meta.dir, "cli");

const commands = new Map(
  await Promise.all(
    readdirSync(folder)
      .filter((file) => /^[a-z]+\.ts$/u.test(file))
      .toSorted()
      .map(async (file): Promise<[string, Command]> => {
        // SAFETY: every file in hub/cli/ default-exports what command() returns.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an import by a path built at run time has no type to narrow from
        const loaded = (await import(join(folder, file))) as { default: Command };

        return [file.slice(0, -3), loaded.default];
      }),
  ),
);

const USAGE = `usage:\n${[...commands.values()]
  .flatMap((each) => each.usage.split("\n"))
  .map((line) => `  ${line}`)
  .join("\n")}`;

const options: ParseArgsOptionsConfig = Object.fromEntries(
  [...commands.values()].flatMap(({ flags }) => Object.entries(flags ?? {})),
);

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options });
const [state = "", name = "", ...args] = positionals;
const command = commands.get(name);

if (state === "" || name === "") {
  usage();
}

for (const [flag, { short }] of Object.entries(options)) {
  if (short !== undefined && flags[flag] !== undefined && command?.flags?.[flag] === undefined) {
    const takers = [...commands].filter(([, { flags: own }]) => own?.[flag] !== undefined);
    console.error(`hex: -${short} is only for ${takers.map(([taker]) => taker).join(", ")}`);
    process.exit(2);
  }
}

const unquotedValue = args[command?.wordsBeforeFlags?.(args) ?? 0];

if (unquotedValue !== undefined) {
  console.error(`hex: ${stray(unquotedValue)}`);
  process.exit(1);
}

if (command === undefined) {
  usage();
}

const hex: Hex = {
  state,
  flags,
  args,
  usage: USAGE,
  get store() {
    return open(state);
  },
};

try {
  await command.run(hex);
} catch (error) {
  console.error(`hex: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function stray(word: string) {
  return `"${word}" isn't a flag's value: quote every value that has spaces, like --title 'Fix the login page'`;
}
