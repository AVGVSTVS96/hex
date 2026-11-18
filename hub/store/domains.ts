import { z } from "zod";

import { now } from "./db.ts";
import type { Core, Write } from "./db.ts";
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
import { Transcripts } from "./transcripts.ts";
import { Turns } from "./turns.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// quiet: a home's write to tables of its own, which it tells no watcher of; a home with no watchers to spare writes them as any other.
export function domains(core: Core, quiet: Write = core.write) {
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
    transcripts: new Transcripts(core, quiet),
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
  transcripts: methodsOfClass(Transcripts),
  clock: ["now"],
} satisfies Record<keyof Domains, string[]>;

export const OffersJson = z.object({
  migrations: z.number().int().nonnegative(),
  methods: z.array(z.string().max(200)).max(10_000),
});

export type Offers = z.infer<typeof OffersJson>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What this hex's store runs: the migrations it keeps its records at and the methods it answers. A client needs the same of a home, and any newer home offers all of it, since migrations only append and methods stay.
export const OFFERS: Offers = {
  migrations: appendOnlyMigrations.length,
  methods: Object.entries(METHODS).flatMap(([domain, names]) =>
    names.map((name) => `${domain}.${name}`),
  ),
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a home lacks of what a client needs, in words, or nothing when it serves that client: a home as new or newer always does.
export function unmet(needs: Offers, offers: Offers = OFFERS): string | undefined {
  const offered = new Set(offers.methods);
  const lacking = needs.methods.filter((method) => !offered.has(method));

  if (needs.migrations > offers.migrations) {
    return `it keeps hex's records at migration ${offers.migrations} and this hex needs ${needs.migrations}`;
  }

  return lacking.length === 0
    ? undefined
    : `it has no ${lacking.slice(0, 3).join(", ")}${lacking.length > 3 ? ` or ${lacking.length - 3} more` : ""}`;
}

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
