import { existsSync } from "node:fs";

import * as claude from "./claude.ts";
import { answered, tracked } from "./kept.ts";
import type { Owing } from "./kept.ts";
import { present } from "./present.ts";
import type { Kept } from "./store.ts";

export const MODELS = [
  { value: "opus", name: "Opus" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
  { value: "fable", name: "Fable" },
];

export const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra High" },
  { value: "max", name: "Max" },
];

export function family(model: string) {
  return MODELS.find(({ value }) => model.startsWith(`claude-${value}-`))?.value ?? model;
}

type Saved = Omit<Kept, "link">;

type Patch = Partial<Pick<Saved, "name">> & {
  [Field in Exclude<keyof Saved, "name">]?: Saved[Field] | undefined;
};

const FIELDS = Object.values({
  name: "name",
  session: "session",
  cwd: "cwd",
  model: "model",
  effort: "effort",
  launched: "launched",
  fork: "fork",
} satisfies { [Field in keyof Saved]-?: Field });

export type Threads = Awaited<ReturnType<typeof openThreads>>;

export async function openThreads({
  app,
  storeDir,
  owing,
  hexDir,
  link,
  tell,
  tellAfter,
}: {
  app: string;
  storeDir: string;
  owing: Owing;
  hexDir: string;
  link: ((thread: string) => string | undefined) | undefined;
  tell?: (why: string) => void;
  tellAfter?: number;
}) {
  const listed = await answered(
    storeDir,
    `the ${app} hub starts`,
    async (store) => {
      await owing.settled();

      return await store.threads.list({ app, open: true });
    },
    { ...(tell !== undefined && { tell }), ...(tellAfter !== undefined && { tellAfter }) },
  );

  const saved = new Map<string, Saved>(
    listed.map(({ app: _app, open: _open, link: _link, thread, model, ...known }) => [
      thread,
      { ...known, ...(present(model) && { model: family(model) }) },
    ]),
  );

  // WARNING: Claude Code can't resume a session that died before it saved its conversation.
  const unsaved = new Map<string, string>();

  let saving: Promise<void> = Promise.resolve();
  let queued = false;

  function save(): Promise<void> {
    if (queued) {
      return saving;
    }

    queued = true;
    const previous = saving;

    saving = tracked(
      (async () => {
        await previous;
        queued = false;
        await owing.must(
          {
            kind: "threads",
            app,
            threads: Object.fromEntries(
              [...saved].map(([thread, known]) => [thread, { ...known, ...linkOf(thread) }]),
            ),
          },
          undefined,
        );
      })(),
    );

    return saving;
  }

  function linkOf(thread: string) {
    try {
      const given = link?.(thread);

      return given === undefined ? {} : { link: given };
    } catch (error) {
      process.stderr.write(`hub: no link for ${app} thread ${thread}: ${String(error)}\n`);

      return {};
    }
  }

  function get(thread: string): Readonly<Saved> | undefined {
    return saved.get(thread);
  }

  function has(thread: string) {
    return saved.has(thread);
  }

  function ids() {
    return [...saved.keys()];
  }

  function of(thread: string): Readonly<Saved> {
    const known = saved.get(thread);

    if (!known) {
      throw new Error(`${app} thread ${thread} isn't open in this hub`);
    }

    return known;
  }

  function find(nameOrThread: string) {
    if (saved.has(nameOrThread)) {
      return nameOrThread;
    }

    const wanted = nameOrThread.trim().toLowerCase();

    const matches = [...saved].flatMap(([thread, known]) =>
      known.name.toLowerCase() === wanted ? [thread] : [],
    );

    const [only] = matches;

    if (matches.length > 1) {
      throw new Error(`more than one thread is named "${nameOrThread}"`);
    }

    if (only === undefined) {
      throw new Error(`no thread named "${nameOrThread}"`);
    }

    return only;
  }

  function cwd(thread: string) {
    return saved.get(thread)?.cwd ?? hexDir;
  }

  function current(thread: string) {
    return unsaved.get(thread) ?? saved.get(thread)?.session;
  }

  function register(thread: string, name: string, folder?: string) {
    if (!saved.has(thread)) {
      open(thread, { name, ...(present(folder) && { cwd: folder }) });
    }
  }

  function open(thread: string, known: Saved) {
    saved.set(thread, known);
    void save();
  }

  function update(thread: string, patch: Patch) {
    const known = saved.get(thread);

    if (!known) {
      return;
    }

    const changed = FIELDS.filter((given) => given in patch && patch[given] !== known[given]);

    for (const field of changed) {
      const value = patch[field];

      if (value === undefined) {
        Reflect.deleteProperty(known, field);
      } else {
        known[field] = value;
      }
    }

    if (changed.length > 0) {
      void save();
    }
  }

  function close(thread: string) {
    const session = saved.get(thread)?.session ?? "";
    saved.delete(thread);
    unsaved.delete(thread);
    void save();

    return session;
  }

  function note(thread: string, session: string) {
    if (saved.get(thread)?.session === session) {
      unsaved.delete(thread);
    } else {
      unsaved.set(thread, session);
    }

    claim(thread);
  }

  function dropUnsaved(thread: string) {
    unsaved.delete(thread);
  }

  function claim(thread: string) {
    const session = unsaved.get(thread);

    if (
      !present(session) ||
      !saved.has(thread) ||
      !existsSync(claude.transcript(cwd(thread), session))
    ) {
      return;
    }

    unsaved.delete(thread);
    update(thread, { session, fork: undefined });
  }

  void save();

  return {
    get,
    has,
    ids,
    of,
    find,
    cwd,
    current,
    register,
    open,
    update,
    close,
    note,
    dropUnsaved,
    claim,
    save,
  };
}
