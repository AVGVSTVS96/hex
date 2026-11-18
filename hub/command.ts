import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { parseArgs, ParseArgsOptionsConfig } from "node:util";

import { checks } from "./ideas.ts";
import type { Store, Task, Thread } from "./store.ts";
import { entry, render } from "./tasks.ts";

type Flags<F extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseArgs<{ options: F; allowPositionals: true }>
>["values"];

export type Hex<F extends ParseArgsOptionsConfig = ParseArgsOptionsConfig> = {
  state: string;
  store: Store;
  flags: Flags<F>;
  args: string[];
  usage: string;
};

export type Command<F extends ParseArgsOptionsConfig = ParseArgsOptionsConfig> = {
  usage: string;
  flags?: F;
  wordsBeforeFlags?: (args: string[]) => number;
  run: (hex: Hex<F>) => Promise<void>;
};

export function command<F extends ParseArgsOptionsConfig>(given: Command<F>): Command {
  return given;
}

export async function commands() {
  const folder = join(import.meta.dir, "cli");

  return new Map(
    await Promise.all(
      readdirSync(folder)
        .toSorted()
        .flatMap((file) => /^([a-z]+)\.ts$/u.exec(file)?.[1] ?? [])
        .map(async (name): Promise<[string, Command]> => {
          // SAFETY: every hub/cli/<name>.ts default-exports what command() returns.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an import by a path built at run time has no type to narrow from
          const loaded = (await import(join(folder, `${name}.ts`))) as { default: Command };

          return [name, loaded.default];
        }),
    ),
  );
}

export function flagsOf(all: Map<string, Command>) {
  const flags: ParseArgsOptionsConfig = {};
  const takers = new Map<string, string>();

  for (const [name, { flags: own = {} }] of all) {
    for (const [flag, option] of Object.entries(own)) {
      const first = takers.get(flag);

      if (first !== undefined && !Bun.deepEquals(flags[flag], option)) {
        throw new Error(
          `--${flag} is declared one way in hub/cli/${first}.ts and another in hub/cli/${name}.ts: a flag means the same in every command`,
        );
      }

      flags[flag] = option;
      takers.set(flag, first ?? name);
    }
  }

  return flags;
}

export function filled(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

export function usage(hex: Hex): never {
  console.error(hex.usage);
  process.exit(2);
}

export async function threadKey(hex: Hex, given: string | undefined) {
  return filled(given) ? await hex.store.threads.key(given) : given;
}

export function ownThread(hex: Hex<{ all: { type: "boolean" } }>) {
  return hex.flags.all === true || filled(process.env.HEX_MAIN)
    ? undefined
    : process.env.HEX_THREAD;
}

function lastFindings(state: string, task: Task) {
  return checks(state, task.id)
    .flatMap(({ at, news, finding }) => (filled(finding) ? [{ at, news, finding }] : []))
    .slice(-5)
    .map(
      ({ at, news, finding }) =>
        `  checked ${at.slice(0, 10)}${news === true ? ", news" : ""}: ${finding}`,
    );
}

export async function show(hex: Hex<{ json: { type: "boolean" } }>, tasks: Task[], full = true) {
  if (hex.flags.json === true) {
    console.log(JSON.stringify(await withThread(hex, tasks, (task) => task.owner), null, 1));

    return;
  }

  const names = await hex.store.threads.names();

  console.log(
    tasks
      .map((task) =>
        full
          ? [render(task, names), ...lastFindings(hex.state, task)].join("\n")
          : entry(task, names),
      )
      .join(full ? "\n\n" : "\n") || "no tasks",
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// every --json output names a thread one way, as <app>:<key>: a thread's id, and threadId on what belongs to one.
export async function withThread<T>(hex: Hex, rows: T[], key: (row: T) => string) {
  const ids = await hex.store.threads.ids();

  return rows.map((row) => {
    const threadId = ids[key(row)];

    return { ...row, ...(filled(threadId) && { threadId }) };
  });
}

export async function named(hex: Hex, given: string) {
  const key = await hex.store.threads.key(given);
  const threads = await hex.store.threads.list();
  const keyed = threads.find(({ thread }) => thread === key);

  if (keyed) {
    return [keyed];
  }

  const wanted = given.trim().toLowerCase();
  const all = threads.filter(({ name }) => name.toLowerCase() === wanted);

  return all.length > 0 ? all : threads.filter(({ thread }) => thread === key.toLowerCase());
}

export function heldBySession(threads: Thread[]) {
  return new Map(
    threads.flatMap(({ app, thread, session }): [string, string][] =>
      filled(session) ? [[session, `${app}:${thread}`]] : [],
    ),
  );
}
