import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { z } from "zod";

import type { Core, Mode } from "./store/db.ts";
import { Holds } from "./store/holds.ts";
import { Jobs } from "./store/jobs.ts";
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

export { StopReasonColumn } from "./store/jobs.ts";

export type { Job, JobSpec, StopReason } from "./store/jobs.ts";

export { asked, isAuthor, replied, sent, shown, spoken } from "./store/messages.ts";

export type { Author, NewRow, Row } from "./store/messages.ts";

export type { Pin } from "./store/pins.ts";

export { waits } from "./store/questions.ts";

export { signalOf, signalTo } from "./store/scheduler.ts";

export type { Answer, NewQuestion, Question } from "./store/questions.ts";

export type { NewTask, Status, Task, TaskChange, Words } from "./store/tasks.ts";

export type { Kept, LaunchStamp, Thread } from "./store/threads.ts";

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

type Domains<M extends Mode> = {
  messages: Messages<M>;
  tasks: Tasks<M>;
  questions: Questions<M>;
  threads: Threads<M>;
  pins: Pins<M>;
  holds: Holds<M>;
  jobs: Jobs<M>;
  turns: Turns<M>;
  profiles: Profiles<M>;
  seen: Seen<M>;
  relays: Relays<M>;
  leases: Leases<M>;
  passes: Passes<M>;
  scheduler: Scheduler<M>;
  operations: Operations<M>;
};

export type Tx = Domains<"tx"> & { db: Database; dir: string };

function domains<M extends Mode>(
  core: Core<M>,
  messages: Messages<M>,
  inside: Messages<"tx">,
): Domains<M> {
  return {
    messages,
    tasks: new Tasks(core, inside),
    questions: new Questions(core),
    threads: new Threads(core),
    pins: new Pins(core),
    holds: new Holds(core, inside),
    jobs: new Jobs(core),
    turns: new Turns(core),
    profiles: new Profiles(core),
    seen: new Seen(core),
    relays: new Relays(core),
    leases: new Leases(core),
    passes: new Passes(core),
    scheduler: new Scheduler(core, inside),
    operations: new Operations(core),
  };
}

const PATIENCE_MS = 30_000;

export class Store {
  readonly dir: string;
  readonly db: Database;
  readonly messages: Messages;
  readonly tasks: Tasks;
  readonly questions: Questions;
  readonly threads: Threads;
  readonly pins: Pins;
  readonly holds: Holds;
  readonly jobs: Jobs;
  readonly turns: Turns;
  readonly profiles: Profiles;
  readonly seen: Seen;
  readonly relays: Relays;
  readonly leases: Leases;
  readonly passes: Passes;
  readonly scheduler: Scheduler;
  readonly operations: Operations;
  private readonly tx: Tx;
  private readonly bell: string;
  private writing = false;
  private waitsForTheLock = true;
  private readonly queue: (() => boolean)[] = [];
  private retry: ReturnType<typeof setTimeout> | undefined;
  private following = 0;
  private front = 1;
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
    this.db.run(`pragma busy_timeout = ${PATIENCE_MS}`);
    retryWhileBusy(() => this.db.run("pragma journal_mode = wal"));
    // synchronous = full flushes the WAL inside the commit, under the write lock every other process waits on: https://www.sqlite.org/pragma.html#pragma_synchronous
    this.db.run("pragma synchronous = normal");
    this.db.run("pragma foreign_keys = on");

    const inside: Core<"tx"> = {
      db: this.db,
      write: (fn) => {
        if (!this.writing) {
          throw new Error("hex.db: a write through a transaction's tx runs inside store.write");
        }

        return fn();
      },
    };

    const queued: Core<"queued"> = { db: this.db, write: (fn) => this.write(fn) };
    const insideMessages = new Messages(inside);

    this.tx = {
      db: this.db,
      dir,
      ...domains(inside, insideMessages, insideMessages),
    };

    ({
      messages: this.messages,
      tasks: this.tasks,
      questions: this.questions,
      threads: this.threads,
      pins: this.pins,
      holds: this.holds,
      jobs: this.jobs,
      turns: this.turns,
      profiles: this.profiles,
      seen: this.seen,
      relays: this.relays,
      leases: this.leases,
      passes: this.passes,
      scheduler: this.scheduler,
      operations: this.operations,
    } = domains(queued, new Messages(queued), insideMessages));

    while (this.version() < appendOnlyMigrations.length) {
      this.transact(() => {
        const version = this.version();
        const step = appendOnlyMigrations[version];

        if (step === undefined) {
          return;
        }

        step(this.tx);
        this.db.run(`pragma user_version = ${version + 1}`);
      });
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Writes commit one at a time, in the order they were asked for, and then: what follows from one, run as soon as it commits and before the next write. The hub's never wait for another process's write lock, which would stop its whole event loop for as long as that process holds it: a write that finds the lock taken waits its turn here and tries again, while the hub goes on with everything else. A write asked for in a then lands before any asked for elsewhere since, as it would if its write had never waited.
  write<T>(fn: (tx: Tx) => T): Promise<T>;
  write<T, U>(fn: (tx: Tx) => T, then: (value: T) => U): Promise<U>;
  write<T, U>(fn: (tx: Tx) => T, then?: (value: T) => U): Promise<T | U> {
    if (this.writing) {
      throw new Error("hex.db: a write inside a write goes through its tx");
    }

    return new Promise<T | U>((resolve, reject) => {
      const attempt = () => {
        try {
          const done = this.transact(() => fn(this.tx));

          if (done === undefined) {
            return false;
          }

          this.following += 1;

          try {
            resolve(then === undefined ? done.value : then(done.value));
          } finally {
            this.following -= 1;
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }

        return true;
      };

      if (this.following === 0) {
        this.queue.push(attempt);
        this.drain();
      } else if (this.front > 1 || !attempt()) {
        this.queue.splice(this.front++, 0, attempt);
      }
    });
  }

  private drain() {
    if (this.retry !== undefined) {
      return;
    }

    for (let first = this.queue[0]; first !== undefined; first = this.queue[0]) {
      if (!first()) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.drain();
        }, 5);

        return;
      }

      this.queue.shift();
      this.front = 1;
    }
  }

  private transact<T>(fn: () => T): { value: T } | undefined {
    const before = this.changes();
    let value: T;

    try {
      value = this.waitsForTheLock
        ? retryWhileBusy(() => this.inTransaction(fn))
        : this.tryOnce(fn);
    } catch (error) {
      if (!this.waitsForTheLock && Busy.parse(error)) {
        return undefined;
      }

      throw error;
    }

    if (this.changes() !== before) {
      this.committed += 1;
      this.syncer?.postMessage(this.committed);

      if (this.syncer === undefined) {
        this.flush();
      }

      appendFileSync(this.bell, ".");
    }

    return { value };
  }

  private tryOnce<T>(fn: () => T): T {
    this.db.run("pragma busy_timeout = 0");

    try {
      return this.inTransaction(fn);
    } finally {
      this.db.run(`pragma busy_timeout = ${PATIENCE_MS}`);
    }
  }

  private inTransaction<T>(fn: () => T): T {
    this.writing = true;

    try {
      return this.db.transaction(fn).immediate();
    } finally {
      this.writing = false;
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The hub's: its writes reach the disk from a thread of their own, and never wait for the write lock.
  syncInBackground() {
    if (this.syncer !== undefined) {
      return;
    }

    this.waitsForTheLock = false;
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

const Busy = z
  .object({ code: z.string().optional(), message: z.string().optional() })
  .transform(({ code, message }) => String(code ?? message).includes("SQLITE_BUSY"))
  .catch(false);

// SQLITE_BUSY can come back despite busy_timeout, to avoid a deadlock: https://www.sqlite.org/c3ref/busy_handler.html
// Running a busy write again is safe, since Bun rolls back a transaction that throws: https://bun.com/docs/runtime/sqlite#transactions
function retryWhileBusy<T>(fn: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!Busy.parse(error) || attempt === 5) {
        throw error;
      }

      Bun.sleepSync(20 * attempt);
    }
  }
}
