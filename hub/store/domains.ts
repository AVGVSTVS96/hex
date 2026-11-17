import { now } from "./db.ts";
import type { Core } from "./db.ts";
import { Holds } from "./holds.ts";
import { Jobs } from "./jobs.ts";
import { Leases } from "./leases.ts";
import { Messages } from "./messages.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { Operations } from "./operations.ts";
import { Passes } from "./passes.ts";
import { Pins } from "./pins.ts";
import { Profiles } from "./profiles.ts";
import { Questions } from "./questions.ts";
import { Relays } from "./relays.ts";
import { Scheduler } from "./scheduler.ts";
import { Seen } from "./seen.ts";
import { Tasks } from "./tasks.ts";
import { Threads } from "./threads.ts";
import { Turns } from "./turns.ts";

export function domains(core: Core) {
  const messages = new Messages(core);
  const questions = new Questions(core, messages);
  const threads = new Threads(core);

  return {
    messages,
    questions,
    threads,
    tasks: new Tasks(core, messages),
    pins: new Pins(core, questions),
    holds: new Holds(core, messages, threads),
    jobs: new Jobs(core),
    turns: new Turns(core, messages),
    profiles: new Profiles(core),
    seen: new Seen(core),
    relays: new Relays(core),
    leases: new Leases(core),
    passes: new Passes(core),
    scheduler: new Scheduler(core, messages),
    operations: new Operations(core),
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The clock that stamps every record: what compares a time against those stamps asks it, since its own machine's can differ from the home's.
    clock: { now },
  };
}

export type Domains = ReturnType<typeof domains>;

const methodsOfClass = (kind: { prototype: object }) =>
  Object.getOwnPropertyNames(kind.prototype).filter((name) => name !== "constructor");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every method a store's home answers, by domain, known without a database, so a client of a home that is elsewhere can be built.
export const METHODS = {
  messages: methodsOfClass(Messages),
  questions: methodsOfClass(Questions),
  threads: methodsOfClass(Threads),
  tasks: methodsOfClass(Tasks),
  pins: methodsOfClass(Pins),
  holds: methodsOfClass(Holds),
  jobs: methodsOfClass(Jobs),
  turns: methodsOfClass(Turns),
  profiles: methodsOfClass(Profiles),
  seen: methodsOfClass(Seen),
  relays: methodsOfClass(Relays),
  leases: methodsOfClass(Leases),
  passes: methodsOfClass(Passes),
  scheduler: methodsOfClass(Scheduler),
  operations: methodsOfClass(Operations),
  clock: ["now"],
} satisfies Record<keyof Domains, string[]>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a home keeps how many migrations its database has had: a file in pragma user_version, a Durable Object, which refuses that pragma, in a table.
export type Version = { get: () => number; set: (version: number) => void };

export function migrate(
  { db, write }: Core,
  { messages, questions, pins, relays }: Domains,
  version: Version,
  dir: string,
) {
  while (version.get() < appendOnlyMigrations.length) {
    write(() => {
      const next = version.get();
      const step = appendOnlyMigrations[next];

      if (step === undefined) {
        return;
      }

      step({ dir, db, messages, questions, pins, relays });
      version.set(next + 1);
    });
  }
}
