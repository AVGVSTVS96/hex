import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  watch,
} from "node:fs";
import { dirname, join } from "node:path";

import * as claude from "./claude.ts";
import { tracked } from "./kept.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import { awayFile, NOTHING, RefusedError } from "./store.ts";
import type { End, Piece, Store } from "./store.ts";
import type { Threads } from "./threads.ts";

// The most text one row of the store holds, well under what a Durable Object takes in a row (https://developers.cloudflare.com/durable-objects/platform/limits/), and short enough on the wire that the hub's other calls, which wait their turn behind it, hardly wait. A send carries the whole lines that end within one, or one line however long.
const PIECE = 256 * 1024;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How much of a transcript's end is digested: each line carries its own id and time, so two files that agree here agree before it, unless one was changed in place with its length kept.
const TAIL = 4096;

const ignore = (): void => undefined;
const TRANSCRIPT = /^(?<session>[\da-f-]{36})\.jsonl$/u;
const NEWLINE = 10;

function tailBefore(file: number, size: number) {
  if (size === 0) {
    return NOTHING.tail;
  }

  const from = Math.max(0, size - TAIL);
  const bytes = Buffer.alloc(size - from);
  readSync(file, bytes, 0, bytes.length, from);

  return createHash("sha256").update(bytes).digest("hex");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code may be midway through a line, so a file counts as far as its last whole one.
function wholeOf(file: number, size: number) {
  const bytes = Buffer.alloc(TAIL);

  for (let upto = size; upto > 0; upto -= TAIL) {
    const from = Math.max(0, upto - TAIL);
    const read = bytes.subarray(0, upto - from);
    readSync(file, read, 0, read.length, from);
    const last = read.lastIndexOf(NEWLINE);

    if (last !== -1) {
      return from + last + 1;
    }
  }

  return 0;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The whole lines that end within a piece of where a send starts, or the one line that runs past it.
function linesFrom(file: number, from: number, whole: number) {
  for (let most = PIECE; ; most *= 2) {
    const bytes = Buffer.alloc(Math.min(whole - from, most));
    readSync(file, bytes, 0, bytes.length, from);
    const lines = bytes.lastIndexOf(NEWLINE) + 1;

    if (lines > 0 || bytes.length === 0) {
      return bytes.subarray(0, lines);
    }
  }
}

function pieces(bytes: Buffer, from: number): Piece[] {
  const cut: Piece[] = [];

  for (let at = 0; at < bytes.length;) {
    let end = Math.min(at + PIECE, bytes.length);

    // oxlint-disable-next-line no-bitwise -- a UTF-8 byte that continues a character, which a piece never ends inside
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }

    cut.push({ upto: from + end, text: bytes.toString("utf-8", at, end) });
    at = end;
  }

  return cut;
}

type More = { pieces: Piece[]; tail: string; of: number };

type Past = More | "gone" | "off";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a machine's file holds past a copy that ends at `end`. gone: there is no file. off: the file doesn't hold the copy's end, so it's shorter than the copy or another conversation from some point on. most: how much to read, none to only say how long the file is.
function past(path: string, end: Pick<End, "size" | "tail">, most = PIECE): Past {
  let file: number;

  try {
    file = openSync(path, "r");
  } catch {
    return "gone";
  }

  try {
    const { size } = fstatSync(file);

    if (size < end.size || tailBefore(file, end.size) !== end.tail) {
      return "off";
    }

    const of = wholeOf(file, size);
    const bytes = most === 0 ? Buffer.alloc(0) : linesFrom(file, end.size, of);

    return {
      pieces: pieces(bytes, end.size),
      tail: tailBefore(file, end.size + bytes.length),
      of,
    };
  } finally {
    closeSync(file);
  }
}

const holdsIt = (more: Past): more is More => more !== "gone" && more !== "off";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether one file is the other cut short: every byte it has is the other's, and the other has more.
function cutShort(short: string, long: string) {
  const [one, other] = [openSync(short, "r"), openSync(long, "r")];

  try {
    const [size, longer] = [fstatSync(one).size, fstatSync(other).size];
    const [mine, theirs] = [Buffer.alloc(PIECE), Buffer.alloc(PIECE)];

    for (let at = 0; at < size; at += PIECE) {
      const read = readSync(one, mine, 0, PIECE, at);

      if (
        readSync(other, theirs, 0, read, at) !== read ||
        !mine.subarray(0, read).equals(theirs.subarray(0, read))
      ) {
        return false;
      }
    }

    return size < longer;
  } finally {
    closeSync(one);
    closeSync(other);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every hub in the process sends through the one client, whose calls reach the store one at a time, so their sends take turns here: the hub's other calls then wait behind one piece at most.
let line: Promise<unknown> = Promise.resolve();

function inLine<T>(call: () => Promise<T>): Promise<T> {
  const answered = line.then(call);
  line = answered.catch(() => null);

  return answered;
}

type Ask = <T>(use: (store: Store) => Promise<T>) => Promise<T | undefined>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The copy, whole, as a file beside where it goes; nothing when the store didn't give all of it.
async function fetched(ask: Ask, session: string, end: End, to: string) {
  const part = `${to}.arriving`;
  mkdirSync(dirname(to), { recursive: true });
  rmSync(part, { force: true });

  for (let size = 0; size < end.size;) {
    const from = size;
    const page = (await ask((store) => store.transcripts.since(session, from))) ?? [];
    const last = page.at(-1);

    if (last === undefined) {
      break;
    }

    appendFileSync(part, page.map(({ text }) => text).join(""));
    size = last.upto;
  }

  const arrived = past(part, end);

  if (holdsIt(arrived) && arrived.of === end.size && arrived.pieces.length === 0) {
    return part;
  }

  rmSync(part, { force: true });
  process.stderr.write(`hub: ${session}'s conversation didn't arrive whole from hex's store\n`);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A file that doesn't hold the end of its own machine's copy was changed in place there, like a secret taken out of it, so the copy starts over from it; unless it is the copy cut short, as a file put back from a backup is, which the copy completes at the session's next start. A copy still short of its file can't tell the two apart, and starts over.
async function changedInPlace(ask: Ask, session: string, path: string, end: End) {
  if (end.size < end.of) {
    return true;
  }

  const copy = await fetched(ask, session, end, path);

  if (copy === undefined) {
    return false;
  }

  try {
    return !cutShort(path, copy);
  } finally {
    rmSync(copy, { force: true });
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// full: the store has no room left for transcripts, which it says by refusing.
const appended = (ask: Ask, session: string, end: End, more: More, by: string, over: boolean) =>
  ask(async (store) => {
    try {
      return await store.transcripts.append(
        session,
        end,
        more.pieces,
        { tail: more.tail, of: more.of, by },
        over,
      );
    } catch (error) {
      if (!(error instanceof RefusedError)) {
        throw error;
      }

      process.stderr.write(
        `hub: ${error.message}; no more of any transcript is sent until the hub next starts\n`,
      );

      return "full";
    }
  });

export type SessionTranscripts = ReturnType<typeof sessionTranscripts>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each open thread's conversation, in hex's store as Claude Code writes it, so its session resumes on whichever machine runs hex: Claude Code keeps a transcript only on the machine it runs on, and resumes only from that file. The store's copy is one machine's file (by), and says how long that file is (of). The hub on that machine sends what the file gained at each change, and starts the copy over when the file was changed in place. A hub on another machine takes the copy before the session starts, and resumes the session only with the whole conversation on its disk: a copy still short of its file isn't one. A thread that starts every turn fresh resumes nothing, and a store in this folder is on the only machine there is, so neither is sent.
export function sessionTranscripts({
  threads,
  kept,
  fresh,
  machine,
}: {
  threads: Pick<Threads, "ids" | "current" | "get" | "cwd">;
  kept: Keep;
  fresh: (thread: string) => boolean;
  machine: string;
}) {
  const ends = new Map<string, End>();
  const sending = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const owed = new Map<string, string>();
  const changed = new Set<string>();
  const watched = new Set<string>();
  const elsewhere = kept((store) => existsSync(awayFile(store.dir)), false);
  let full = false;

  const ask: Ask = (use) => inLine(() => kept(use, undefined));

  function files() {
    const held = new Map<string, string>();

    for (const thread of threads.ids().filter((each) => !fresh(each))) {
      const folder = claude.transcriptsIn(threads.cwd(thread));

      for (const session of [threads.current(thread), threads.get(thread)?.session]) {
        if (present(session)) {
          held.set(session, join(folder, `${session}.jsonl`));
        }
      }
    }

    return held;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // sizeOnly: says whose file the copy is and how long it is, and sends none of it, so a copy is known to be short before the first of its bytes go.
  async function send(session: string, path: string, sizeOnly: boolean) {
    if (full) {
      return;
    }

    for (let over = false; ;) {
      const end = ends.get(session) ?? (await ask((store) => store.transcripts.end(session)));

      if (end === undefined) {
        owed.set(session, path);

        return;
      }

      const more = past(path, over ? NOTHING : end, sizeOnly ? 0 : PIECE);
      ends.set(session, end);

      if (more === "gone") {
        return;
      }

      if (more === "off") {
        ends.delete(session);

        const startsOver =
          end.by === machine &&
          (changed.delete(session) || (await changedInPlace(ask, session, path, end)));

        if (!startsOver) {
          return;
        }

        over = true;
        continue;
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // Another machine's copy that says its file was longer than this one: this file is an older state of the conversation, and never takes the copy's place.
      if (end.by !== machine && more.of < end.of) {
        return;
      }

      if (!over && more.pieces.length === 0 && end.by === machine && end.of === more.of) {
        owed.delete(session);

        return;
      }

      const now = await appended(ask, session, end, more, machine, over);

      if (now === undefined) {
        ends.delete(session);
        owed.set(session, path);
      }

      if (now === undefined || now === "full") {
        full ||= now === "full";

        return;
      }

      over = false;
      ends.set(session, now);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the store didn't take is owed until it answers again, which its watch says: a session that then stays quiet changes its file no more.
  function sendOwed() {
    for (const [session, path] of owed) {
      owed.delete(session);
      void ship(session, path);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One send at a time for a transcript, and one more waiting however many changes come meanwhile, since a send takes all the file holds when it starts. A hub that stops waits for the sends under way (tracked), by when the sessions it leaves are frozen.
  function ship(session: string, path: string, sizeOnly = false): Promise<void> {
    const before = sending.get(session) ?? Promise.resolve();

    if (!sizeOnly && queued.has(session)) {
      return before;
    }

    if (!sizeOnly) {
      queued.add(session);
    }

    const sent = tracked(
      (async () => {
        await before;

        if (!sizeOnly) {
          queued.delete(session);
        }

        try {
          await send(session, path, sizeOnly);
        } catch (error) {
          process.stderr.write(`hub: couldn't send ${path} to hex's store: ${String(error)}\n`);
        }
      })(),
    );

    sending.set(session, sent);

    return sent;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A watch holds no process open: the hub's exit ends it.
  function follow(folder: string) {
    if (watched.has(folder) || !existsSync(folder)) {
      return;
    }

    watched.add(folder);
    watch(folder, (_change, name) => {
      const session = TRANSCRIPT.exec(name ?? "")?.groups?.session;

      if (present(session) && files().has(session)) {
        void ship(session, join(folder, `${session}.jsonl`));
      }
    }).unref();
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Whether this machine holds a session's whole conversation once the store's copy is here. The copy takes the place of a file that is it cut short, and of another machine's version of it, which is kept beside it for the lines the store never got; a file its own machine changed in place stays, and the copy starts over from it. A store that holds nothing of a session says nothing against the file here.
  async function brought(session: string, to: string) {
    const end = (await ask((store) => store.transcripts.end(session))) ?? NOTHING;
    const path = existsSync(to) ? to : (claude.transcriptOf(session) ?? to);
    const mine = past(path, end, 0);

    if (end.of === 0) {
      return true;
    }

    if (holdsIt(mine)) {
      return end.by === machine || mine.of >= end.of;
    }

    const copy = end.size < end.of ? undefined : await fetched(ask, session, end, path);

    if (copy === undefined) {
      return false;
    }

    if (mine === "off" && !cutShort(path, copy)) {
      if (end.by === machine) {
        rmSync(copy, { force: true });
        changed.add(session);

        return true;
      }

      renameSync(path, `${path}.set-aside-${Date.now()}`);
    }

    renameSync(copy, path);
    ends.set(session, end);
    process.stderr.write(
      `hub: ${session}'s conversation came from hex's store, since ${mine === "gone" ? "this machine had none of it" : "this machine's file wasn't it"}\n`,
    );

    return true;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Before a thread's session starts: the conversations it resumes or forks from are on this machine as the store holds them, and its folder is watched from here on. Whether the thread's own session can be resumed here, which one this machine holds only part of can't. A landing that fails leaves the start to go on with what the machine has.
  async function land(thread: string, fork?: string) {
    if (!(await elsewhere)) {
      return true;
    }

    const known = fresh(thread) ? undefined : threads.get(thread);
    const folder = claude.transcriptsIn(threads.cwd(thread));
    let whole = true;

    try {
      for (const session of new Set([known?.session, known?.fork, fork].filter(present))) {
        const path = join(folder, `${session}.jsonl`);
        const isHere = await brought(session, path);
        whole &&= isHere || session !== known?.session;

        if (isHere && files().has(session)) {
          void ship(session, path);
        }
      }

      mkdirSync(folder, { recursive: true });
      follow(folder);
    } catch (error) {
      process.stderr.write(
        `hub: ${thread}'s conversation couldn't be brought from hex's store, so its session starts with what this machine has: ${String(error)}\n`,
      );
    }

    return whole;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // As the hub starts: what the store holds of sessions no open thread is on goes. Then the store is told how long every transcript is, before what the sessions wrote while no hub watched is sent, one transcript after another.
  async function catchUp() {
    if (!(await elsewhere)) {
      return;
    }

    void kept((store) => store.watch(sendOwed), ignore);
    await ask((store) => store.transcripts.prune());

    for (const thread of threads.ids()) {
      follow(claude.transcriptsIn(threads.cwd(thread)));
    }

    for (const sizeOnly of [true, false]) {
      for (const [session, path] of files()) {
        if (existsSync(path)) {
          await ship(session, path, sizeOnly);
        }
      }
    }
  }

  void catchUp();

  return { land };
}
