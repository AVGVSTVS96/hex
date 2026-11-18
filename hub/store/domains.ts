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

export function domains(core: Core, writeNoWatcherHears: Write = core.write) {
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
    transcripts: new Transcripts(core, writeNoWatcherHears),
    clock: { now },
  };
}

export type Domains = ReturnType<typeof domains>;

const methodsOfClass = (kind: { prototype: object }) =>
  Object.getOwnPropertyNames(kind.prototype).filter((name) => name !== "constructor");

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

export const OFFERS: Offers = {
  migrations: appendOnlyMigrations.length,
  methods: Object.entries(METHODS).flatMap(([domain, names]) =>
    names.map((name) => `${domain}.${name}`),
  ),
};

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
