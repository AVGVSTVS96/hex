import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  awayFile,
  isAuthor,
  LostError,
  MovedError,
  open,
  OtherStoreError,
  RefusedError,
  unclaimed,
  UnreachedError,
} from "./store.ts";
import type {
  Author,
  Cut,
  Kept,
  NewQuestion,
  NewRow as NewRowType,
  Row,
  Store,
  Told,
} from "./store.ts";
import { AnswerJson } from "./store/questions.ts";

export type Keep = <T>(use: (store: Store) => Promise<T> | T, otherwise: T) => Promise<T>;

const FIRST_LOOK_AGAIN = 1000;
const LONGEST_WAIT = 30_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How long a hub waits for its store at start before the owner hears it can't start.
const TELL_AFTER_MS = 60_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The tenure this process's claim was given (serve.ts), which a spool records each write under, so a later hub can tell whether another held hex since.
let tenure: number | undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A file home's claim is 0: one machine, one hub, so no tenure to tell hubs apart by.
export function claimedAs(given: number | undefined) {
  tenure = given === undefined || given <= 0 ? undefined : given;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// This process takes hex over: every hub that claimed the store before it is refused from then on. commit: the one of hex this hub runs, which the store then says to a machine that takes hex over next.
export async function takeOver(store: Store, commit?: string) {
  claimedAs(await store.claim(commit));
}

const ignore = (): void => undefined;

const queuedOnly = async (pass: Pass, store: Store) => {
  await store.passes.wait(pass);
};

const underWay = new Set<Promise<unknown>>();

const losing = new Set<(why: string) => void>();

const moving = new Set<() => void>();

const AnyNewRow = z.object({
  key: z.string(),
  to: z.string(),
  from: z.string(),
  author: z.custom<Author>(isAuthor),
  body: z.string(),
  meta: z.record(z.string(), z.string()).optional(),
  at: z.string().optional(),
});

export const OwedRow = z.custom<NewRowType>((value) => AnyNewRow.safeParse(value).success);

const PASS = z.object({ session: z.string(), by: z.string(), thread: z.string().optional() });

export type Pass = z.infer<typeof PASS>;

const MessageId = z.union([z.number(), z.string()]);

const AnyQuestion = z.looseObject({
  app: z.string(),
  thread: z.string(),
  message: MessageId,
  text: z.string(),
  options: z.array(z.string()),
});

const AnyTold = z.union([
  z.object({
    answered: z.object({
      message: MessageId,
      label: z.string(),
      via: z.string(),
      again: z.boolean().optional(),
    }),
    always: z.boolean().optional(),
  }),
  z.object({
    reopened: z.object({ message: MessageId, label: z.string().optional() }),
    always: z.boolean().optional(),
  }),
]);

const AnyKept = z.record(
  z.string(),
  z.looseObject({ name: z.string(), session: z.string().optional() }),
);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A write the hub owes hex's store, as it's kept on disk until the store takes it, so a restart meanwhile loses nothing.
export const OwedWrite = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deliver"), row: OwedRow, by: z.string().optional() }),
  z.object({
    kind: z.literal("told"),
    app: z.string(),
    thread: z.string(),
    change: z.custom<Told>((value) => AnyTold.safeParse(value).success),
    row: OwedRow,
  }),
  z.object({ kind: z.literal("take"), key: z.string(), by: z.string(), at: z.string().optional() }),
  z.object({
    kind: z.literal("threads"),
    app: z.string(),
    threads: z.custom<Record<string, Kept>>((value) => AnyKept.safeParse(value).success),
  }),
  z.object({ kind: z.literal("letHeldGo"), thread: z.string() }),
  z.object({
    kind: z.literal("cut"),
    thread: z.string(),
    session: z.string().optional(),
    at: z.string(),
    note: OwedRow,
  }),
  z.object({
    kind: z.literal("paused"),
    thread: z.string(),
    session: z.string(),
    needs: z.string().optional(),
  }),
  z.object({ kind: z.literal("pass"), pass: PASS }),
  z.object({
    kind: z.literal("operation"),
    scope: z.string(),
    id: z.string(),
    input: z.string(),
    result: z.string().nullable(),
    begun: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("asked"),
    question: z.custom<NewQuestion>((value) => AnyQuestion.safeParse(value).success),
  }),
  z.object({
    kind: z.literal("replied"),
    app: z.string(),
    thread: z.string(),
    answer: AnswerJson,
    to: MessageId.optional(),
  }),
]);

export type Owed = z.infer<typeof OwedWrite>;

export type Paused = Extract<Owed, { kind: "paused" }>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What hex said, as the questions ledger notes it: a question it asked, or a reply that answers what the owner asked (all the owner asked in the thread, or the one question at to).
export type Note = Extract<Owed, { kind: "asked" | "replied" }>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What stays true whoever holds hex: a message, a take, a session cut short, a turn's memory pass, a tap's answer, a tool call's record, a question hex asked and a reply to one question, each landing once by its key. A whole snapshot of an app's threads, the release of what was held for a turn and the telling of a session that paused are this hub's own, worth nothing once another hub held hex. So is a reply's note of every question the owner had open (replied, with no to): the store marks the ones open as it lands, so once another hub has held hex it would mark what the owner asked since.
const isFact = (write: Owed) =>
  write.kind !== "threads" &&
  write.kind !== "letHeldGo" &&
  write.kind !== "paused" &&
  !(write.kind === "replied" && write.to === undefined);

const SpoolLine = z.object({ write: z.unknown(), tenure: z.number().optional() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each write once, by what it writes: a message by its key, the threads of an app by the app, so a later one takes an earlier one's place.
function keyOf(owed: Owed) {
  switch (owed.kind) {
    case "deliver":
    case "told": {
      return owed.row.key;
    }

    case "take": {
      return `taken:${owed.key}`;
    }

    case "threads": {
      return `threads:${owed.app}`;
    }

    case "letHeldGo": {
      return `held:${owed.thread}`;
    }

    case "cut": {
      return `cut:${owed.thread}:${owed.session ?? ""}`;
    }

    case "paused": {
      return `paused:${owed.session}`;
    }

    case "pass": {
      return `pass:${owed.pass.session}:${owed.pass.by}`;
    }

    case "operation": {
      return `operation:${owed.scope}:${owed.id}`;
    }

    case "asked": {
      return `asked:${owed.question.app}:${owed.question.thread}:${owed.question.message}`;
    }

    case "replied": {
      return `replied:${owed.app}:${owed.thread}:${owed.answer.message ?? owed.answer.at}`;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The time the hub was given what it owes, so it's kept as of then, not as of when the store came back, and the turn's memory pass finds it.
function asOf(owed: Owed, at: string): Owed {
  switch (owed.kind) {
    case "deliver":
    case "told": {
      return { ...owed, row: { ...owed.row, at: owed.row.at ?? at } };
    }

    case "take": {
      return { ...owed, at: owed.at ?? at };
    }

    case "asked": {
      return { ...owed, question: { ...owed.question, at: owed.question.at ?? at } };
    }

    case "threads":
    case "letHeldGo":
    case "cut":
    case "paused":
    case "pass":
    case "operation":
    case "replied": {
      return owed;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Under a store across the network's limit on a row (8 MiB, counted in UTF-8 bytes), with room left for the rest of the row.
const MOST_KEPT_BYTES = 7_000_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the store keeps of a message it refused, one after another as each is refused too: a body too long for it cut down to what it takes, then only a note, each under the message's key, so the message isn't lost without a trace and the app sending it again changes nothing. A change to hex's records the store refused tells nothing (told).
function standIns(owed: Owed, why: string): Owed[] {
  if (owed.kind !== "deliver") {
    return [];
  }

  const { row } = owed;
  const bytes = new TextEncoder().encode(row.body);
  const said = `[hub] hex's store refused this message (${why.slice(0, 400)})`;

  const instead = (body: string, refused: string): Owed => ({
    kind: "deliver",
    row: { ...row, body, meta: { ...row.meta, refused } },
    ...(owed.by !== undefined && { by: owed.by }),
  });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A row the store refuses for what's in it, like its key, still leaves a note of its own the store takes, in the same thread, kept as taken so no session is given it.
  const noteOfItsOwn: Owed = {
    kind: "deliver",
    by: "hub",
    row: {
      key: `hub:refused:${Bun.hash(row.key).toString(36)}`,
      to: row.to,
      from: "hub",
      author: "prompt",
      body: `${said}, so it keeps only this note of it, which hex keeps whole in its refused file; its session was given it.`,
      meta: { refused: "aside", user: "hub" },
      ...(row.at !== undefined && { at: row.at }),
    },
  };

  return [
    ...(bytes.length > MOST_KEPT_BYTES
      ? [
          instead(
            `${new TextDecoder().decode(bytes.subarray(0, MOST_KEPT_BYTES)).replace(/\uFFFD$/u, "")}\n${said}, so it keeps only the part above; its session was given all of it.`,
            "cut",
          ),
        ]
      : []),
    instead(`${said}, so it keeps only this note of it; its session was given it.`, "true"),
    noteOfItsOwn,
  ];
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store call a hub started, counted until it's answered (landed).
export function tracked<T>(call: Promise<T>): Promise<T> {
  const forget = () => {
    underWay.delete(call);
  };

  underWay.add(call);
  void call.then(forget, forget);

  return call;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Resolves once every store call the hubs in this process had started has been answered, so what they wrote is the store's before the process says so or exits. Whether there were any.
export async function landed() {
  const answering = [...underWay];
  await Promise.allSettled(answering);

  return answering.length > 0;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Told once a store refuses this process's tenure: another machine holds hex, and the process stops as a hub that lost it.
export function whenLost(listener: (why: string) => void) {
  losing.add(listener);

  return () => {
    losing.delete(listener);
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Told once the hex.db a hub opened has had its records moved to a store across the network, so the process starts again on it.
export function whenMoved(listener: () => void) {
  moving.add(listener);

  return () => {
    moving.delete(listener);
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether the error says another machine holds hex, telling whoever waits for that.
export const lost = (error: unknown): error is LostError => {
  if (!(error instanceof LostError)) {
    return false;
  }

  for (const listener of losing) {
    listener(error.message);
  }

  return true;
};

function tellMoved() {
  for (const listener of moving) {
    listener();
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether the error says the hex.db the process opened has moved, telling whoever waits for that. open() hands out the store it moved to from then on.
const moved = (error: unknown): error is MovedError => {
  if (!(error instanceof MovedError)) {
    return false;
  }

  tellMoved();

  return true;
};

function rings(store: Store, wait: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unwatch();
      resolve();
    };

    const timer = setTimeout(done, wait);
    const unwatch = store.watch(done);
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A call of a process that opened hex.db before a move took its records, such as a session's hook that waited on the move's lock: made again on the store the records moved to, which open() hands out once the move has written store.json.
export async function followed<T>(storeDir: string, use: (store: Store) => Promise<T>): Promise<T> {
  try {
    return await use(open(storeDir));
  } catch (error) {
    if (!(error instanceof MovedError)) {
      throw error;
    }

    return await use(open(storeDir));
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the hub can't start without, from a store that may not answer as it starts: it waits, saying so, instead of exiting as a hub that can't start, which bin/hex would take for a bad commit, and looks again once the store's bell rings, as it does when it reconnects, or after a wait. A wait past a minute is told (tell), once, since some never end on their own: a wrong key, a deleted Worker, a hex newer than its store, a hex.db whose records moved without the store.json that says where. One whose store says another machine holds hex never starts.
export async function answered<T>(
  storeDir: string,
  what: string,
  use: (store: Store) => Promise<T>,
  {
    tell = ignore,
    tellAfter = TELL_AFTER_MS,
  }: { tell?: (why: string) => void; tellAfter?: number } = {},
): Promise<T> {
  const since = Date.now();
  let told = false;

  for (let wait = FIRST_LOOK_AGAIN; ; wait = Math.min(wait * 2, LONGEST_WAIT)) {
    try {
      const value = await use(open(storeDir));

      if (wait > FIRST_LOOK_AGAIN) {
        process.stderr.write(`hub: hex's store answers again, so ${what}\n`);
      }

      return value;
    } catch (error) {
      if (lost(error)) {
        return await new Promise<never>(ignore);
      }

      if (error instanceof MovedError && existsSync(awayFile(storeDir))) {
        continue;
      }

      if (!(error instanceof UnreachedError || error instanceof MovedError)) {
        throw error;
      }

      if (wait === FIRST_LOOK_AGAIN) {
        process.stderr.write(
          `hub: hex's store doesn't answer, so the hub waits for it before ${what}: ${String(error)}\n`,
        );
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A store running another hex's code waits on a deploy, not a while, so the owner hears it at once.
      if (!told && (error instanceof OtherStoreError || Date.now() - since >= tellAfter)) {
        told = true;
        tell(error.message);
      }

      await (error instanceof MovedError ? Bun.sleep(wait) : rings(open(storeDir), wait));
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A spool's lines, each read on its own, so one cut short as its write was stopped costs only itself. A spool hex wrote before its lines had a tenure is one JSON array of writes.
function spoolLines(spool: string): string[] {
  let text: string;

  try {
    text = readFileSync(spool, "utf-8");
  } catch (error) {
    process.stderr.write(
      `hub: couldn't read what it owes hex's store (${spool}): ${String(error)}\n`,
    );

    return [];
  }

  const asList = text.trimStart().startsWith("[") ? readAs(z.array(z.unknown()), text) : undefined;

  return asList === undefined
    ? text.split("\n").filter((line) => line.trim() !== "")
    : asList.map((write) => JSON.stringify({ write }));
}

function readAs<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a hub owed hex's store when it last stopped, from its spool: a line for each write as it was owed, a later one for a key taking an earlier one's place. A write made under a tenure that isn't the one just before this hub's own was made before another hub held hex, so only what's a fact of it is still owed.
function owedIn(spool: string): Owed[] {
  if (!existsSync(spool)) {
    return [];
  }

  const owed = new Map<string, Owed>();

  for (const line of spoolLines(spool)) {
    const read = readAs(SpoolLine, line);
    const write = OwedWrite.safeParse(read?.write);

    if (!write.success) {
      process.stderr.write(`hub: dropped a write owed to hex's store it can't read: ${line}\n`);
      continue;
    }

    const since = read?.tenure;
    const handedOver = tenure !== undefined && since !== undefined && tenure !== since + 1;

    if (handedOver && !isFact(write.data)) {
      process.stderr.write(
        `hub: dropped a ${write.data.kind} write owed from tenure ${String(since)}, since another hub has held hex since\n`,
      );
      continue;
    }

    owed.set(keyOf(write.data), write.data);
  }

  return [...owed.values()];
}

const lineOf = (write: Owed) =>
  `${JSON.stringify({ write, ...(tenure !== undefined && { tenure }) })}\n`;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A disk that can't take the spool leaves what's owed in the hub's memory alone, as before hex kept a spool, so a failing disk never leaves hex deaf. Each write owed is a line added; the whole is written again only as what's owed is paid.
function spooled(spool: string, act: () => void): boolean {
  try {
    act();

    return true;
  } catch (error) {
    process.stderr.write(
      `hub: couldn't keep what it owes hex's store on disk (${spool}), so only this hub's memory holds it: ${String(error)}\n`,
    );

    return false;
  }
}

function keepOwed(spool: string, owed: Owed[]) {
  return spooled(spool, () => {
    if (owed.length === 0) {
      rmSync(spool, { force: true });
    } else {
      writeFileSync(`${spool}.next`, owed.map(lineOf).join(""));
      renameSync(`${spool}.next`, spool);
    }
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the hub running here does as a write it owed lands late: pass on what was let go or given back, tell a chat. A hub says so once its owners exist (serve); none until then, or where what's owed is paid without a hub.
export type Late = {
  letGo: (thread: string, rows: Row[]) => void;
  cut: (thread: string, cut: Cut) => Promise<void>;
  paused: (paused: Paused, store: Store) => Promise<void>;
};

type Doing = {
  late: () => Late | null;
  queue: (pass: Pass, store: Store) => Promise<void>;
};

async function madeOn(store: Store, write: Owed, { late, queue }: Doing): Promise<boolean> {
  switch (write.kind) {
    case "deliver": {
      return await store.messages.deliver(write.row, write.by);
    }

    case "told": {
      return await store.questions.told(write.app, write.thread, write.change, write.row);
    }

    case "take": {
      return await store.messages.take(write.key, write.by, write.at);
    }

    case "threads": {
      await store.threads.keep(write.app, write.threads);

      return true;
    }

    case "letHeldGo": {
      const rows = await store.messages.letHeldGo(write.thread);
      late()?.letGo(write.thread, rows);

      return true;
    }

    case "cut": {
      const made = await store.turns.cut(write.thread, write.session, write.at, write.note);
      await late()?.cut(write.thread, made);

      return true;
    }

    case "paused": {
      await late()?.paused(write, store);

      return true;
    }

    case "pass": {
      await queue(write.pass, store);

      return true;
    }

    case "operation": {
      if (write.begun !== true) {
        await store.operations.begin(write.scope, write.id, write.input);
      }

      if (write.result !== null) {
        await store.operations.finish(write.scope, write.id, write.result);
      }

      return true;
    }

    case "asked": {
      await store.questions.ask(write.question);

      return true;
    }

    case "replied": {
      await store.questions.replied(write.app, write.thread, write.answer, write.to);

      return true;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a store call's failure means for what it wrote: a refusal only when the store refused it, or, while this hub still holds hex, any error the store didn't say it couldn't take; for a hub that lost hex, only a refusal the store said.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a store call threw
function outcomeOf(error: unknown, lostAlready: boolean): "unreached" | "refused" {
  if (moved(error)) {
    return "unreached";
  }

  if (error instanceof UnreachedError || (lostAlready && !(error instanceof RefusedError))) {
    process.stderr.write(
      `hub: hex's store can't take anything now, so the hub goes on from memory and keeps it once it can: ${String(error)}\n`,
    );

    return "unreached";
  }

  process.stderr.write(
    `hub: hex's store refused a call, which won't ever land: ${error instanceof RefusedError ? error.message : String(error)}\n`,
  );

  return "refused";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store while it opens and writes. What the hub must keep (must) and the store couldn't take is owed: kept on disk (spool), made again by its key, in the order it was first made and before anything after it, once the store answers, and until then nothing the hub was given is safe (synced); meanwhile the hub goes on from memory, so an outage never leaves hex deaf. What the store refuses outright is dropped, a message keeping a note in its place. A hex.db that moved is followed to where it went (open), and a store that says another machine holds hex stops the hub (lost).
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a hub owes as it starts: its spool, then any an older hex kept elsewhere, then what was set aside as refused, tried again at each start so a store fixed since takes it; all of it in the spool from then on, and the others removed only once the spool holds it.
function owedAtStart(spool: string, others: string[]) {
  const owed = new Map<string, Owed>();

  for (const write of [spool, ...others].flatMap(owedIn)) {
    owed.set(keyOf(write), write);
  }

  if (keepOwed(spool, [...owed.values()])) {
    for (const other of others) {
      spooled(other, () => {
        rmSync(other, { force: true });
      });
    }
  }

  return owed.values();
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A tool call's record, which keeps it to running once: the store's, or the hub's own while it's owed, so a repeat is answered from it until the store has it. A call the store can't be asked about counts as new, since a first call and a repeat of one that ended before the outage look the same from here. Its end is one write where the store has its start (begun), and the whole record where the start is still owed.
function operationsOwed({
  owed,
  current,
  failed,
  owe,
  must,
}: {
  owed: Map<string, Owed>;
  current: () => Store;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a store call threw
  failed: (error: unknown) => "lost" | "unreached" | "refused";
  owe: (write: Owed) => void;
  must: (write: Owed, otherwise: boolean) => Promise<boolean>;
}) {
  return {
    begin: async (scope: string, id: string, input: string) => {
      const mine = owed.get(keyOf({ kind: "operation", scope, id, input, result: null }));

      if (mine?.kind === "operation") {
        return { fresh: false, input: mine.input, result: mine.result };
      }

      try {
        return await tracked(current().operations.begin(scope, id, input));
      } catch (error) {
        if (failed(error) !== "unreached") {
          throw error;
        }

        owe({ kind: "operation", scope, id, input, result: null });

        return { fresh: true, input, result: null };
      }
    },
    finish: async (scope: string, id: string, input: string, result: string) => {
      const whole = { kind: "operation" as const, scope, id, input, result };
      await must({ ...whole, begun: !owed.has(keyOf(whole)) }, false);
    },
  };
}

export function keeping(
  storeDir: string,
  {
    app,
    earlier = [],
    queue,
    tell = ignore,
    lost: lostAlready,
  }: Pick<Doing, "queue"> & {
    app: string;
    earlier?: string[];
    tell?: (why: string) => void;
    lost?: LostError;
  },
) {
  const spool = join(storeDir, `owed.${app}.json`);
  const refused = join(storeDir, `refused.${app}.json`);
  const owed = new Map<string, Owed>();
  let home = open(storeDir);
  let hub: Late | null = null;
  const late = () => hub;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // open() hands out the store across the network once a move has written store.json, so the hub follows it from its next call, and restarts to listen there.
  function current() {
    const now = open(storeDir);

    if (now !== home) {
      home = now;
      process.stderr.write(
        `hub: hex's records moved from ${storeDir}/hex.db to the store state/store.json names, so the hub goes on there and restarts on it\n`,
      );
      tellMoved();
    }

    return now;
  }

  const retried = new Set(owedIn(refused).map(keyOf));

  for (const write of owedAtStart(spool, [...earlier, refused])) {
    owed.set(keyOf(write), write);
  }

  let refusal = lostAlready;
  let paying: Promise<void> | undefined;
  let told = false;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Once another hub holds hex, what this one owes as fact goes through a client that never claimed, which no tenure refuses, and the rest is let go; a turn's memory pass is only queued in the store, for the machine that holds hex to run.
  const made = async (write: Owed) =>
    await (refusal === undefined
      ? madeOn(current(), write, { late, queue })
      : madeOn(unclaimed(storeDir), write, { late, queue: queuedOnly }));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a store call threw
  const failed = (error: unknown): "lost" | "unreached" | "refused" => {
    if (lost(error)) {
      refusal ??= error;

      return "lost";
    }

    return outcomeOf(error, refusal !== undefined);
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A write the store refused once is refused again, so a message keeps a note in its place, and anything else is dropped. Whether the store answered: what it couldn't take is owed.
  async function attempt(
    write: Owed,
    instead?: Owed[],
    first = write,
  ): Promise<{ answered: boolean; value?: boolean }> {
    try {
      return { answered: true, value: await made(write) };
    } catch (error) {
      const how = failed(error);

      if (how === "unreached") {
        return { answered: false };
      }

      if (how === "lost") {
        return { answered: !isFact(write) };
      }

      const [next, ...rest] = instead ?? standIns(write, String(error));

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A message the store won't take even under its own key is set aside, whole, in the refused file before its note of its own is tried, so what comes after it still lands and nothing is lost; the owner hears which, and that hex tries it again at its next start.
      if (next?.kind === "deliver" && next.row.meta?.refused === "aside") {
        setAside(first, String(error));
      }

      if (next !== undefined) {
        return await attempt(next, rest, first);
      }

      return { answered: true };
    }
  }

  function setAside(write: Owed, why: string) {
    spooled(refused, () => {
      appendFileSync(refused, lineOf(write));
    });

    if (!told && !retried.has(keyOf(write))) {
      told = true;
      tell(
        `hex's store refused a message under its own key (${keyOf(write)}): ${why}. Its thread has a note of it, it's kept whole in ${refused} with any others it refuses, and hex tries them again each time it starts; delete one's line there to give up on it.`,
      );
    }
  }

  function owe(write: Owed) {
    if (refusal === undefined || isFact(write)) {
      owed.set(keyOf(write), write);
      spooled(spool, () => {
        appendFileSync(spool, lineOf(write));
      });
    }
  }

  async function payInTurn() {
    const before = owed.size;

    try {
      for (const [key, write] of owed) {
        if (refusal !== undefined && !isFact(write)) {
          owed.delete(key);
          continue;
        }

        if (!(await attempt(write)).answered) {
          return;
        }

        owed.delete(key);
      }
    } finally {
      if (owed.size !== before) {
        keepOwed(spool, [...owed.values()]);
      }
    }
  }

  function pay(): Promise<void> {
    if (paying === undefined && owed.size > 0) {
      const turn = tracked(payInTurn());
      paying = turn;
      void turn.finally(() => {
        paying = undefined;
      });
    }

    return paying ?? Promise.resolve();
  }

  const kept: Keep = (use, otherwise) =>
    tracked(
      (async () => {
        try {
          return await use(current());
        } catch (error) {
          failed(error);

          return otherwise;
        }
      })(),
    );

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the store answered, or otherwise when it didn't (owed) or refused it.
  function must<T>(write: Owed, otherwise: T): Promise<boolean | T> {
    const given = asOf(write, new Date().toISOString());

    return tracked(
      (async () => {
        await pay();

        if (owed.size > 0) {
          owe(given);

          return otherwise;
        }

        const { answered: took, value } = await attempt(given);

        if (!took) {
          owe(given);
        }

        return value ?? otherwise;
      })(),
    );
  }

  async function synced() {
    await pay();

    if (refusal !== undefined) {
      if (owed.size > 0) {
        await pay();
      }

      throw refusal;
    }

    if (owed.size > 0) {
      throw new UnreachedError(
        `${owed.size} of hex's records the hub holds wait for hex's store to take them`,
      );
    }

    try {
      await tracked(current().synced());
    } catch (error) {
      if (failed(error) !== "refused") {
        throw error;
      }
    }
  }

  return {
    kept,
    must,
    operations: operationsOwed({ owed, current, failed, owe, must }),
    owe: (write: Owed) => {
      owe(asOf(write, new Date().toISOString()));
      void pay();
    },
    pay,
    serve: (running: Late) => {
      hub = running;
    },
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Once what was owed is the store's, so what the hub reads from it is current: rejects while anything is still owed.
    settled: async () => {
      await pay();

      if (owed.size > 0) {
        throw new UnreachedError(
          `${owed.size} of hex's records the hub holds wait for hex's store`,
        );
      }
    },
    owes: (write: Owed) => owed.has(keyOf(write)),
    synced,
    lost: () => refusal !== undefined,
  };
}

export type Owing = ReturnType<typeof keeping>;

export type Operations = Owing["operations"];

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the hubs of a folder owed as fact, paid with no hub and no claim, through a client no tenure refuses, as a process that lost hex stops or never starts (bin/hex, hub/paid.ts), the way a hub pays it: a message the store refuses is set aside, and what the store didn't answer stays in its spool. The spools are the folder's, its refused files, and those a hex before this one kept in each app's own folder. Whether nothing is still owed.
export async function payOwedFacts(storeDir: string, tell?: (why: string) => void) {
  const names = existsSync(storeDir) ? readdirSync(storeDir) : [];

  const apps = new Set([
    ...names.flatMap((name) => /^(?:owed|refused)\.(.+)\.json$/u.exec(name)?.[1] ?? []),
    ...names.filter((name) => existsSync(join(storeDir, name, `owed.${name}.json`))),
  ]);

  let paid = true;

  for (const app of apps) {
    const owing = keeping(storeDir, {
      app,
      earlier: [join(storeDir, app, `owed.${app}.json`)],
      queue: queuedOnly,
      ...(tell !== undefined && { tell }),
      lost: new LostError("this process lost hex, or never held it"),
    });

    try {
      await owing.settled();
    } catch {
      paid = false;
    }
  }

  return paid;
}
