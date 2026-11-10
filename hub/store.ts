import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { z } from "zod";

import type { Core } from "./store/db.ts";
import { Holds } from "./store/holds.ts";
import { Leases } from "./store/leases.ts";
import { Messages } from "./store/messages.ts";
import { appendOnlyMigrations } from "./store/migrations.ts";
import { Operations } from "./store/operations.ts";
import { Passes } from "./store/passes.ts";
import { Pins } from "./store/pins.ts";
import { Profiles } from "./store/profiles.ts";
import { Questions } from "./store/questions.ts";
import { Relays } from "./store/relays.ts";
import { Scheduler } from "./store/scheduler.ts";
import { Seen } from "./store/seen.ts";
import { Tasks } from "./store/tasks.ts";
import { Threads } from "./store/threads.ts";
import { Turns } from "./store/turns.ts";

export type { MessageId } from "./store/db.ts";

export type { Held, Hold, NewHold } from "./store/holds.ts";

export { asked, isAuthor, replied, sent, shown, spoken } from "./store/messages.ts";

export type { Author, NewRow, Row } from "./store/messages.ts";

export type { Pin } from "./store/pins.ts";

export { waits } from "./store/questions.ts";

export type { Answer, NewQuestion, Question } from "./store/questions.ts";

export type { NewTask, Status, Task, TaskChange, Words } from "./store/tasks.ts";

export type { Kept, LaunchStamp, Thread } from "./store/threads.ts";

const UserVersionRow = z.object({ user_version: z.number() });
const DataVersionRow = z.object({ data_version: z.number() });
const ChangesRow = z.object({ n: z.number() });

export class Store {
  readonly dir: string;
  readonly db: Database;
  readonly messages: Messages;
  readonly tasks: Tasks;
  readonly questions: Questions;
  readonly threads: Threads;
  readonly pins: Pins;
  readonly holds: Holds;
  readonly turns: Turns;
  readonly profiles: Profiles;
  readonly seen: Seen;
  readonly relays: Relays;
  readonly leases: Leases;
  readonly passes: Passes;
  readonly scheduler: Scheduler;
  readonly operations: Operations;
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
    this.db.run("pragma busy_timeout = 30000");
    retryWhileBusy(() => this.db.run("pragma journal_mode = wal"));
    this.db.run("pragma synchronous = full");
    this.db.run("pragma foreign_keys = on");

    const core: Core = { db: this.db, write: (fn) => this.write(fn) };
    this.messages = new Messages(core);
    this.tasks = new Tasks(core, this.messages);
    this.questions = new Questions(core);
    this.threads = new Threads(core);
    this.pins = new Pins(core);
    this.holds = new Holds(core, this.messages);
    this.turns = new Turns(core);
    this.profiles = new Profiles(core);
    this.seen = new Seen(core);
    this.relays = new Relays(core);
    this.leases = new Leases(core);
    this.passes = new Passes(core);
    this.scheduler = new Scheduler(core, this.messages);
    this.operations = new Operations(core);

    while (this.version() < appendOnlyMigrations.length) {
      this.write(() => {
        const version = this.version();
        const step = appendOnlyMigrations[version];

        if (step === undefined) {
          return;
        }

        step(this);
        this.db.run(`pragma user_version = ${version + 1}`);
      });
    }
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
      appendFileSync(this.bell, ".");
    }

    return result;
  }

  syncInBackground() {
    if (this.syncer !== undefined) {
      return;
    }

    this.db.run("pragma synchronous = normal");
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

  private waitForTheDisk() {
    this.syncer = undefined;
    this.db.run("pragma synchronous = full");
    this.db.run("pragma wal_autocheckpoint = 1000");

    const wal = openSync(join(this.dir, "hex.db-wal"), "r");

    try {
      fsyncSync(wal);
    } finally {
      closeSync(wal);
    }

    this.onDisk = this.committed;

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

  private version() {
    return UserVersionRow.parse(this.db.query("pragma user_version").get()).user_version;
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

const stores = new Map<string, Store>();

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

export function open(dir: string): Store {
  const kept = stores.get(dir);

  if (kept !== undefined) {
    return kept;
  }

  const store = new Store(dir);
  stores.set(dir, store);

  if (inBackground) {
    store.syncInBackground();
  }

  return store;
}

export function syncInBackground() {
  inBackground = true;

  for (const store of stores.values()) {
    store.syncInBackground();
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
