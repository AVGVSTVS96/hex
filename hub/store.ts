import { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  watch,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { z } from "zod";

import { onlyReading } from "./store/db.ts";
import { domains, migrate } from "./store/domains.ts";
import type { Domains } from "./store/domains.ts";
import { MovedError } from "./store/errors.ts";
import type { Row } from "./store/messages.ts";
import { awayFile, remote } from "./store/remote.ts";
import type { Home } from "./store/remote.ts";
import { answering, client } from "./store/wire.ts";
import type { Client } from "./store/wire.ts";

export { awayFile, unlease } from "./store/remote.ts";

export {
  LostError,
  MovedError,
  OtherStoreError,
  RefusedError,
  UnaskedError,
  UnreachedError,
} from "./store/errors.ts";

export type { MessageId } from "./store/db.ts";

export type { Held, Hold, NewHold } from "./store/holds.ts";

export { when } from "./store/holds.ts";

export { StopReasonColumn } from "./store/jobs.ts";

export type { Job, JobSpec, StopReason } from "./store/jobs.ts";

export { asked, isAuthor, replied, sent, shown, spoken } from "./store/messages.ts";

export type { Author, NewRow, Row } from "./store/messages.ts";

export type { Pin } from "./store/pins.ts";

export { waits } from "./store/questions.ts";

export { signalOf, signalTo } from "./store/scheduler.ts";

export type { Due, Listening } from "./store/scheduler.ts";

export type { Answer, NewQuestion, Question, Told } from "./store/questions.ts";

export type { NewTask, Status, Task, TaskChange, Words } from "./store/tasks.ts";

export type { Kept, LaunchStamp, Thread } from "./store/threads.ts";

export { MARKS, NOTHING } from "./store/transcripts.ts";

export type { End, Mark, Piece } from "./store/transcripts.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// hex's records, as every caller holds them: each call is answered by the store's home, which is this folder's hex.db (File) or, when the folder's store.json names one, a Durable Object every machine reaches (store/remote.ts, store/object.ts).
export type Store = Client & Home;

const UserVersionRow = z.object({ user_version: z.number() });
const DataVersionRow = z.object({ data_version: z.number() });
const ChangesRow = z.object({ n: z.number() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A Bun process that exits with a database still open checkpoints it and empties its WAL, even while other processes have it open, so the next write elsewhere starts the WAL over and fsyncs; one closed first leaves the WAL as it is.
const openDatabases = new Set<Database>();

process.once("exit", () => {
  for (const db of openDatabases) {
    db.close();
  }
});

export class File {
  readonly dir: string;
  readonly db: Database;
  readonly store: Store;
  readonly messages: Domains["messages"];
  readonly tasks: Domains["tasks"];
  readonly questions: Domains["questions"];
  readonly threads: Domains["threads"];
  readonly pins: Domains["pins"];
  readonly holds: Domains["holds"];
  readonly jobs: Domains["jobs"];
  readonly turns: Domains["turns"];
  readonly profiles: Domains["profiles"];
  readonly seen: Domains["seen"];
  readonly relays: Domains["relays"];
  readonly leases: Domains["leases"];
  readonly passes: Domains["passes"];
  readonly scheduler: Domains["scheduler"];
  readonly operations: Domains["operations"];
  readonly transcripts: Domains["transcripts"];
  readonly clock: Domains["clock"];
  private readonly bell: string;
  private writing = false;
  private readonly listeners = new Set<() => void>();
  private watcher: FSWatcher | undefined;
  private heard = "";
  private syncer: Worker | undefined;
  private committed = 0;
  private onDisk = 0;
  private readonly waiting = new Set<{ upTo: number; resolve: () => void }>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.bell = join(dir, "hex.bell");
    appendFileSync(this.bell, "");
    this.db = new Database(join(dir, "hex.db"), { create: true, strict: true });
    openDatabases.add(this.db);
    this.db.run("pragma busy_timeout = 30000");
    retryWhileBusy(() => this.db.run("pragma journal_mode = wal"));
    // synchronous = full flushes the WAL inside the commit, under the write lock every other process waits on: https://www.sqlite.org/pragma.html#pragma_synchronous
    this.db.run("pragma synchronous = normal");
    this.db.run("pragma foreign_keys = on");

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A hex.db whose records moved refuses every write, so it's no home, as on a machine that restored a copy of it without the store.json that says where they went.
    if (
      this.db
        .query("select 1 from sqlite_master where type = 'trigger' and name glob 'moved_*'")
        .get() !== null
    ) {
      this.db.close();
      openDatabases.delete(this.db);

      throw new MovedError(
        `hex's records in ${dir} moved to a Durable Object, and store.json, which says which, isn't here: copy state/store.json from a machine that runs hex`,
      );
    }

    const core = { db: this.db, write: <T>(fn: () => T) => this.write(fn) };
    const records = domains(core);
    this.messages = records.messages;
    this.tasks = records.tasks;
    this.questions = records.questions;
    this.threads = records.threads;
    this.pins = records.pins;
    this.holds = records.holds;
    this.jobs = records.jobs;
    this.turns = records.turns;
    this.profiles = records.profiles;
    this.seen = records.seen;
    this.relays = records.relays;
    this.leases = records.leases;
    this.passes = records.passes;
    this.scheduler = records.scheduler;
    this.operations = records.operations;
    this.transcripts = records.transcripts;
    this.clock = records.clock;
    migrate(
      core,
      records,
      {
        get: () => UserVersionRow.parse(this.db.query("pragma user_version").get()).user_version,
        set: (version) => {
          this.db.run(`pragma user_version = ${version}`);
        },
      },
      dir,
    );

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A move writes store.json before it locks hex.db's tables, so once it's there this file is no longer hex's store, for whatever opened it before.
    const here = () => {
      if (existsSync(awayFile(dir))) {
        throw new MovedError(
          `hex's records in ${dir} moved to a Durable Object since this process opened hex.db: open the store again`,
        );
      }
    };

    const home: Home = {
      dir,
      claim: () => Promise.resolve(0),
      watch: (listener) => this.watch(listener),
      synced: () => this.synced(),
      // oxlint-disable-next-line typescript/require-await -- async so a query SQLite refuses rejects, as a home that is elsewhere does
      read: async (text, ...bound) => {
        here();
        const reader = new Database(join(dir, "hex.db"), { strict: true });
        reader.run("pragma busy_timeout = 30000");
        reader.run("pragma query_only = on");

        try {
          return reader.query(onlyReading(text)).all(...bound);
        } finally {
          reader.close();
        }
      },
      copy: (to) => {
        this.db.run("vacuum into ?", [to]);

        return Promise.resolve();
      },
    };

    const answer = answering(records);

    this.store = {
      // oxlint-disable-next-line typescript/require-await -- async so a moved folder rejects, as every call to a home does
      ...client(async (call) => {
        here();
        const reply = answer(call);

        if ("error" in reply) {
          here();
        }

        return JSON.stringify(reply);
      }),
      ...home,
    };
  }

  write<T>(fn: () => T): T {
    if (this.writing) {
      return fn();
    }

    const before = this.changes();

    const result = retryWhileBusy(() => {
      this.writing = true;

      try {
        return this.db.transaction(fn).immediate();
      } finally {
        this.writing = false;
      }
    });

    if (this.changes() !== before) {
      this.committed += 1;
      this.syncer?.postMessage(this.committed);

      if (this.syncer === undefined) {
        this.flush();
      }

      appendFileSync(this.bell, ".");
    }

    return result;
  }

  syncInBackground() {
    if (this.syncer !== undefined) {
      return;
    }

    this.db.run("pragma wal_autocheckpoint = 0");
    this.startSyncer();
  }

  synced(): Promise<void> {
    const upTo = this.committed;

    if (this.syncer === undefined || this.onDisk >= upTo) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiting.add({ upTo, resolve });
    });
  }

  private startSyncer() {
    const syncer = new Worker(join(import.meta.dir, "store/syncer.ts"), {
      workerData: { db: join(this.dir, "hex.db") },
    });

    syncer.unref();
    syncer.on("message", (upTo: number) => {
      this.onDisk = Math.max(this.onDisk, upTo);

      for (const each of this.waiting) {
        if (each.upTo <= this.onDisk) {
          this.waiting.delete(each);
          each.resolve();
        }
      }
    });
    syncer.on("error", (error) => {
      process.stderr.write(
        `hex.db: the sync thread failed, so writes wait for the disk again: ${String(error)}\n`,
      );
    });
    syncer.on("exit", () => {
      this.waitForTheDisk();
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads Worker has no origin
    syncer.postMessage(this.committed);
    this.syncer = syncer;
  }

  private flush() {
    const wal = openSync(join(this.dir, "hex.db-wal"), "r");

    try {
      fsyncSync(wal);
    } finally {
      closeSync(wal);
    }

    this.onDisk = this.committed;
  }

  private waitForTheDisk() {
    this.syncer = undefined;
    this.db.run("pragma wal_autocheckpoint = 1000");
    this.flush();

    for (const each of this.waiting) {
      each.resolve();
    }

    this.waiting.clear();
  }

  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    this.watcher ??= watch(this.bell, () => {
      this.rang();
    });

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size > 0) {
        return;
      }

      this.watcher?.close();
      this.watcher = undefined;
    };
  }

  // Bun's fs.watch on Linux drops a change within about a millisecond of the last: https://github.com/oven-sh/bun/issues/45954
  private rang(again = false) {
    const moved = this.moved();

    if (moved !== this.heard) {
      this.heard = moved;

      for (const each of this.listeners) {
        try {
          each();
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    } else if (again) {
      return;
    }

    setTimeout(() => {
      if (this.watcher !== undefined) {
        this.rang(true);
      }
    }, 5);
  }

  private moved() {
    const { data_version: otherProcessesCommits } = DataVersionRow.parse(
      this.db.query("pragma data_version").get(),
    );

    return `${otherProcessesCommits}:${this.changes()}`;
  }

  private changes() {
    return ChangesRow.parse(this.db.query("select total_changes() as n").get()).n;
  }
}

const MESSAGES_AT_ONCE = 500;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every message after a time, oldest first, a page to a reply, since a home across the network can't answer with the whole log at once.
export async function* messagesSince(store: Store, after = ""): AsyncGenerator<Row[]> {
  for (let past = ""; ;) {
    const page = await store.messages.since(after, past, MESSAGES_AT_ONCE);

    if (page.length > 0) {
      yield page;
    }

    const last = page.at(-1);

    if (last === undefined) {
      return;
    }

    past = last.key;
  }
}

const files = new Map<string, File>();

const nonEmptyEnv = (name: string) => {
  const value = process.env[name];

  return value === "" ? undefined : value;
};

export const hexDir = () => nonEmptyEnv("HEX_DIR") ?? join(import.meta.dir, "..", "..");

export function stateDir(appFolder?: string) {
  if (appFolder !== undefined && appFolder !== "") {
    const hex = nonEmptyEnv("HEX_DIR");

    return hex === undefined ? appFolder : join(hex, "state");
  }

  return nonEmptyEnv("HEX_STORE") ?? join(hexDir(), "state");
}

let inBackground = false;

export function file(dir: string): File {
  const kept = files.get(dir);

  if (kept !== undefined) {
    return kept;
  }

  const opened = new File(dir);
  files.set(dir, opened);

  if (inBackground) {
    opened.syncInBackground();
  }

  return opened;
}

const remotes = new Map<string, Store>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A client of the folder's store of its own, which never claims hex, so no tenure refuses it, and keeps whether the object answers to itself: what a hub that lost hex still owes as plain fact, or a backup, goes through one.
export function unclaimed(dir: string): Store {
  return remote(dir, undefined, false) ?? file(dir).store;
}

const readers = new Map<string, Store>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A client of its own for what reads the store in bulk, like boards and status posts, so their reads never wait in line ahead of the hub's own calls, nor its synced. Each call is a round trip to the object, and a client in order sends them one at a time, which keeps a board's redraws as often as they've always been; status posts, read on a change and needing an answer in seconds, send theirs at once. It claims nothing, and shares whether the object answers with the folder's other processes.
export function reading(dir: string, inOrder = true): Store {
  const key = `${String(inOrder)}:${dir}`;
  const kept = readers.get(key);

  if (kept !== undefined) {
    return kept;
  }

  const away = remote(dir, undefined, true, inOrder);

  if (away === undefined) {
    return file(dir).store;
  }

  readers.set(key, away);

  return away;
}

export function open(dir: string): Store {
  const kept = remotes.get(dir);

  if (kept !== undefined) {
    return kept;
  }

  const away = remote(dir);

  if (away === undefined) {
    return file(dir).store;
  }

  remotes.set(dir, away);

  return away;
}

export function syncInBackground() {
  inBackground = true;

  for (const each of files.values()) {
    each.syncInBackground();
  }
}

const SqliteFailure = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

// SQLITE_BUSY can come back despite busy_timeout, to avoid a deadlock: https://www.sqlite.org/c3ref/busy_handler.html
// Running a busy write again is safe, since Bun rolls back a transaction that throws: https://bun.com/docs/runtime/sqlite#transactions
function retryWhileBusy<T>(fn: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const failure = SqliteFailure.safeParse(error).data;

      if (!String(failure?.code ?? failure?.message).includes("SQLITE_BUSY") || attempt === 5) {
        throw error;
      }

      Bun.sleepSync(20 * attempt);
    }
  }
}
