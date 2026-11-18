import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import * as claude from "./claude.ts";
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The bytes whose base64 is one piece.
const RAW = (PIECE / 4) * 3;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where Claude Code keeps, beside a session's transcript, each tool result too long for it: the transcript's line holds the file's path and its first lines, and the session reads the rest from the file. Its names are ids, and the store's copy is brought back only under such a name.
const BESIDE = "tool-results";
const NAME = /^[\w-][\w.-]*$/u;
const ARRIVING = ".arriving";

const ignore = (): void => undefined;
const TRANSCRIPT = /^(?<session>[\da-f-]{36})\.jsonl$/u;
const NEWLINE = 10;

const besideOf = (path: string) => join(path.slice(0, -".jsonl".length), BESIDE);

function named(folder: string) {
  try {
    return readdirSync(folder).filter((name) => NAME.test(name) && !name.includes(ARRIVING));
  } catch {
    return [];
  }
}

function sizeOf(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

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

type More = { pieces: Piece[] } & Pick<End, "tail" | "of" | "last">;

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
      last: tailBefore(file, of),
    };
  } finally {
    closeSync(file);
  }
}

const holdsIt = (more: Past): more is More => more !== "gone" && more !== "off";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether a file is the conversation a copy is of: it holds the end of the file the copy was made from, which the copy itself may still be short of.
const isItsFile = (path: string, end: End) =>
  holdsIt(past(path, { size: end.of, tail: end.last }, 0));

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
// A call can go unanswered alone, on a network that drops one request, so what a session's start depends on is asked a second time before it counts as not there.
const twice =
  (ask: Ask): Ask =>
  async (use) =>
    (await ask(use)) ?? (await ask(use));

function holdsAll(path: string, end: End) {
  const file = openSync(path, "r");

  try {
    return fstatSync(file).size === end.size && tailBefore(file, end.size) === end.tail;
  } finally {
    closeSync(file);
  }
}

let fetches = 0;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a copy arrives before it takes its file's name: a file of this fetch's own, since a send and a session's start may each be bringing the same copy. What an earlier hub left of one, stopped midway, goes.
function arrivingAt(to: string) {
  const [folder, mine] = [dirname(to), `${basename(to)}${ARRIVING}-${process.pid}-`];
  mkdirSync(folder, { recursive: true });

  for (const left of readdirSync(folder)) {
    if (left.startsWith(`${basename(to)}${ARRIVING}`) && !left.startsWith(mine)) {
      rmSync(join(folder, left), { force: true });
    }
  }

  fetches += 1;

  return join(folder, `${mine}${fetches}`);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The copy the store holds under a key, whole, as a file beside where it goes; nothing when the store didn't give all of it. bytes: what a piece's text stands for, when it isn't the text itself.
async function fetched(
  ask: Ask,
  [key, end]: [string, End],
  to: string,
  bytes: (text: string) => string | Buffer = (text) => text,
) {
  const part = arrivingAt(to);

  try {
    writeFileSync(part, "");

    for (let size = 0; size < end.size;) {
      const from = size;
      const page = (await twice(ask)((store) => store.transcripts.since(key, from))) ?? [];
      const last = page.at(-1);

      if (last === undefined) {
        break;
      }

      for (const { text } of page) {
        appendFileSync(part, bytes(text));
      }

      size = last.upto;
    }

    if (holdsAll(part, end)) {
      return part;
    }
  } catch (error) {
    rmSync(part, { force: true });

    throw error;
  }

  rmSync(part, { force: true });
  process.stderr.write(`hub: ${key} didn't arrive whole from hex's store\n`);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A file that doesn't hold the end of its own machine's copy was changed in place there, like a secret taken out of it, so the copy starts over from it; unless it is the copy cut short, as a file put back from a backup is, which the copy completes at the session's next start, and may have by the time the copy is here to compare. A copy still short of its file can't tell the two apart, and starts over.
async function changedInPlace(ask: Ask, session: string, path: string, end: End) {
  if (end.size < end.of) {
    return true;
  }

  const copy = await fetched(ask, [session, end], path);

  if (copy === undefined) {
    return false;
  }

  try {
    return !holdsIt(past(path, end, 0)) && !cutShort(path, copy);
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
        { tail: more.tail, of: more.of, last: more.last, by },
        over,
      );
    } catch (error) {
      if (!(error instanceof RefusedError)) {
        throw error;
      }

      process.stderr.write(
        `hub: ${error.message}; until the hub next starts the store is told only how long each transcript is\n`,
      );

      return "full";
    }
  });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One file beside a transcript, sent from where the store's copy of it stands, or from its start when the copy isn't the start of this file. true: the store holds all of it. false: this file can't be sent now, which holds up nothing else. Nothing: the store didn't answer.
async function besideSent(ask: Ask, key: string, path: string, by: string) {
  let file: number;

  try {
    file = openSync(path, "r");
  } catch {
    return false;
  }

  try {
    const of = fstatSync(file).size;
    let end = await ask((store) => store.transcripts.end(key));

    if (end === undefined) {
      return end;
    }

    let over = end.size > of || tailBefore(file, end.size) !== end.tail;

    for (let at = over ? 0 : end.size; at < of;) {
      const read = Buffer.alloc(Math.min(RAW, of - at));
      readSync(file, read, 0, read.length, at);
      const upto = at + read.length;

      const more = {
        pieces: [{ upto, text: read.toString("base64") }],
        tail: tailBefore(file, upto),
        of,
        last: NOTHING.last,
      };

      const now = await appended(ask, key, end, more, by, over);

      if (now === undefined || now === "full") {
        return now;
      }

      if (now.size !== upto) {
        return false;
      }

      [end, over, at] = [now, false, upto];
    }

    return true;
  } finally {
    closeSync(file);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The files beside a transcript that the store holds whole and this machine doesn't, brought here: one this machine has none of, or another machine's that this one has otherwise. A session's start doesn't wait for them: until one is here the session has what its transcript's line shows of it, and each start asks again for what is still missing.
async function besidesBrought(ask: Ask, machine: string, session: string, path: string) {
  const folder = besideOf(path);

  try {
    for (const { file, ...end } of (await ask((store) => store.transcripts.besides(session))) ??
      []) {
      const name = file.slice(BESIDE.length + 1);
      const to = join(folder, name);
      const here = sizeOf(to);

      if (
        file === `${BESIDE}/${name}` &&
        NAME.test(name) &&
        end.size === end.of &&
        (here === -1 || (end.by !== machine && here !== end.of))
      ) {
        const copy = await fetched(ask, [`${session}/${file}`, end], to, (text) =>
          Buffer.from(text, "base64"),
        );

        if (copy !== undefined) {
          renameSync(copy, to);
        }
      }
    }
  } catch (error) {
    process.stderr.write(
      `hub: what is beside ${session}'s conversation couldn't be brought from hex's store: ${String(error)}\n`,
    );
  }
}

const underWay = new Set<Promise<void>>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The sends under way are done. A hub that stops waits for them, since the sessions it leaves are frozen by then and the next hub may be on another machine, where a session resumes only from a whole copy; nothing else waits on a send, which is as long as what a session wrote.
export async function sent() {
  await Promise.all(underWay);
}

type Send = (session: string, path: string, declares: boolean) => Promise<void>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One send at a time for a transcript, and one more waiting however many changes come meanwhile, since a send takes all the file holds when it starts. declares: a send that only says how long the file is, which waits its turn like any.
function shipping(send: Send) {
  const sending = new Map<string, Promise<void>>();
  const queued = new Set<string>();

  return function ship(session: string, path: string, declares = false): Promise<void> {
    const before = sending.get(session) ?? Promise.resolve();

    if (!declares && queued.has(session)) {
      return before;
    }

    if (!declares) {
      queued.add(session);
    }

    const shipped = (async () => {
      await before;

      if (!declares) {
        queued.delete(session);
      }

      try {
        await send(session, path, declares);
      } catch (error) {
        process.stderr.write(`hub: couldn't send ${path} to hex's store: ${String(error)}\n`);
      }
    })();

    sending.set(session, shipped);
    underWay.add(shipped);
    void shipped.then(() => underWay.delete(shipped));

    return shipped;
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A watch holds no process open: the hub's exit ends it. A folder that can't be watched, as on a machine out of watches, is still sent from at each hub's start and each session's.
function following(changed: (session: string, path: string) => void) {
  const watched = new Set<string>();

  return function follow(folder: string) {
    if (watched.has(folder) || !existsSync(folder)) {
      return;
    }

    try {
      watch(folder, (_change, name) => {
        const session = TRANSCRIPT.exec(name ?? "")?.groups?.session;

        if (present(session)) {
          changed(session, join(folder, `${session}.jsonl`));
        }
      })
        .on("error", (error) => {
          process.stderr.write(`hub: stopped watching ${folder}: ${String(error)}\n`);
          watched.delete(folder);
        })
        .unref();
      watched.add(folder);
    } catch (error) {
      process.stderr.write(`hub: can't watch ${folder}: ${String(error)}\n`);
    }
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a hub knows of the copies, and how it asks the store: a send in turn with every other send in the process (ask), a session's start at once (first), since it is a few calls a thread waits on and a hub's start may have hundreds of sends ahead of it. ends: where each stands, while this hub's own sends are all that move it. heard: where the store last said each stands. beside: the files beside each transcript that the store holds whole, and how long. changed: the files found changed in place on this machine, whose copies start over. written: the sessions whose transcript changed on this machine under this hub, which holds hex, so no other machine has more of them.
type Known = {
  ask: Ask;
  first: Ask;
  machine: string;
  ends: Map<string, End>;
  heard: Map<string, End>;
  beside: Map<string, Map<string, number>>;
  changed: Set<string>;
  written: Set<string>;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The files beside a transcript that the store doesn't hold as they are now, sent. Nothing: the store didn't answer.
async function besidesSent({ ask, machine, beside }: Known, session: string, path: string) {
  const folder = besideOf(path);
  const names = named(folder);
  let there = beside.get(session);

  if (names.length > 0 && there === undefined) {
    const held = await ask((store) => store.transcripts.besides(session));

    if (held === undefined) {
      return held;
    }

    there = new Map(
      held
        .filter((end) => end.size === end.of)
        .map((end) => [end.file.slice(BESIDE.length + 1), end.of]),
    );
    beside.set(session, there);
  }

  for (const name of names) {
    const size = sizeOf(join(folder, name));

    if (there?.get(name) !== size) {
      const key = `${session}/${BESIDE}/${name}`;
      const took = await besideSent(ask, key, join(folder, name), machine);

      if (took === undefined || took === "full") {
        return took;
      }

      if (took) {
        there?.set(name, size);
      }
    }
  }

  return true;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether this machine holds a session's whole conversation once the store's copy is here. The copy takes the place of a file that is it cut short, and of another machine's version of it, which is kept beside it for the lines the store never got, the only place they are; a file its own machine changed in place stays, and the copy starts over from it. A store that holds nothing of a session says nothing against the file here. One that doesn't answer leaves what it last said of the session to this hub, or that the session wrote here under this hub: without either, the file here may be an older one, and isn't resumed.
async function brought(
  { first, machine, ends, heard, changed, written }: Known,
  session: string,
  to: string,
) {
  const end = (await twice(first)((store) => store.transcripts.end(session))) ?? heard.get(session);
  const path = existsSync(to) ? to : (claude.transcriptOf(session) ?? to);

  if (end === undefined) {
    process.stderr.write(
      `hub: hex's store didn't say where ${session}'s conversation stands, so it ${written.has(session) ? "goes on from this machine's file, which it wrote under this hub" : "isn't resumed from this machine's file"}\n`,
    );

    return written.has(session) && existsSync(path);
  }

  heard.set(session, end);
  const mine = past(path, end, 0);

  if (end.of === 0) {
    return true;
  }

  if (holdsIt(mine)) {
    return end.by === machine || isItsFile(path, end);
  }

  if (mine === "off" && end.by === machine && end.size < end.of) {
    changed.add(session);

    return true;
  }

  const copy = end.size < end.of ? undefined : await fetched(first, [session, end], path);

  if (copy === undefined) {
    return false;
  }

  return placed({ machine, ends, changed }, [session, end], copy, path);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A copy that arrived takes its place, by what the machine's file is now: another start, or a send, may have been at the same session while it came.
function placed(
  { machine, ends, changed }: Pick<Known, "machine" | "ends" | "changed">,
  [session, end]: [string, End],
  copy: string,
  path: string,
) {
  const mine = past(path, end, 0);

  if (holdsIt(mine)) {
    rmSync(copy, { force: true });

    return end.by === machine || isItsFile(path, end);
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
    `hub: ${session}'s conversation came from hex's store, since ${mine === "gone" ? "this machine had none of it" : "this machine's file wasn't all of it"}\n`,
  );

  return true;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session's conversation, here as the store holds it, with the files beside it on their way. A landing that fails, as on a disk with no room, leaves no whole conversation here that anything shows.
async function landing(known: Known, session: string, path: string) {
  try {
    if (!(await brought(known, session, path))) {
      return false;
    }
  } catch (error) {
    process.stderr.write(
      `hub: ${session}'s conversation couldn't be brought from hex's store: ${String(error)}\n`,
    );

    return false;
  }

  void besidesBrought(known.ask, known.machine, session, path);

  return true;
}

export type SessionTranscripts = ReturnType<typeof sessionTranscripts>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each open thread's conversation, in hex's store as Claude Code writes it, so its session resumes on whichever machine runs hex: Claude Code keeps a transcript only on the machine it runs on, and resumes only from that file. The store's copy is one machine's file (by), and says how long that file is and how it ends (of, last). The hub on that machine sends what the file gained at each change, the tool results beside it first, and starts the copy over when the file was changed in place. A hub on another machine takes the copy before the session starts, and resumes the session only with the whole conversation on its disk: a copy still short of its file isn't one, and neither is a file the store can't be asked about. A thread that starts every turn fresh resumes nothing, and a store in this folder is on the only machine there is, so neither is sent.
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
  const owed = new Map<string, string>();
  const elsewhere = kept((store) => existsSync(awayFile(store.dir)), false);
  let full = false;

  const known: Known = {
    ask: (use) => inLine(() => kept(use, undefined)),
    first: (use) => kept(use, undefined),
    machine,
    ends: new Map(),
    heard: new Map(),
    beside: new Map(),
    changed: new Set(),
    written: new Set(),
  };

  const { ask, ends, heard, changed } = known;

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
  // declares: says whose file the copy is and how long it is, and sends none of it, so a copy is known to be short before the first of its bytes go; all a store with no room left is told. A line that names a file beside the transcript was written after that file, so what the file holds is read first, then the files beside it are sent, then those lines.
  async function send(session: string, path: string, declares: boolean) {
    for (let over = false; ;) {
      const end = ends.get(session) ?? (await ask((store) => store.transcripts.end(session)));

      if (end === undefined) {
        owed.set(session, path);

        return;
      }

      const more = past(path, over ? NOTHING : end, declares || full ? 0 : PIECE);
      ends.set(session, end);
      heard.set(session, end);

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
      // Another machine's copy whose file this one isn't: this file is an older state of the conversation, or another one from some line on, and never takes the copy's place.
      if (end.by !== machine && !isItsFile(path, end)) {
        return;
      }

      const besides = declares || full ? true : await besidesSent(known, session, path);

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // Nothing to say: the copy is this machine's and stands where its file does, or it is another machine's, whole, and this file is that one to the byte, as on a machine that just took hex over, which then takes a copy as its own only with the first line a session writes here.
      const said = end.by === machine ? end.last === more.last : end.size === end.of;

      if (besides === true && !over && more.pieces.length === 0 && end.of === more.of && said) {
        owed.delete(session);

        return;
      }

      const now =
        besides === true ? await appended(ask, session, end, more, machine, over) : besides;

      if (now === undefined) {
        ends.delete(session);
        owed.set(session, path);

        return;
      }

      if (now === "full") {
        full = true;
        continue;
      }

      over = false;
      ends.set(session, now);
      heard.set(session, now);
    }
  }

  const ship = shipping(send);

  const follow = following((session, path) => {
    if (files().has(session)) {
      known.written.add(session);
      void ship(session, path);
    }
  });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the store didn't take is owed until it answers again, which its watch says: a session that then stays quiet changes its file no more.
  function sendOwed() {
    for (const [session, path] of owed) {
      owed.delete(session);
      void ship(session, path);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Before a thread's session starts: the conversations it resumes or forks from are on this machine as the store holds them, and its folder is watched from here on. Whether the one this start goes on from, the thread's own or the one it forks, is whole here: one this machine holds only part of can't be resumed or forked.
  async function land(thread: string, fork?: string) {
    if (!(await elsewhere)) {
      return true;
    }

    const session = fresh(thread) ? undefined : threads.get(thread);
    const goesOnFrom = fork ?? session?.session ?? session?.fork;
    const folder = claude.transcriptsIn(threads.cwd(thread));
    let whole = true;

    for (const each of new Set([session?.session, session?.fork, fork].filter(present))) {
      const path = join(folder, `${each}.jsonl`);
      const isHere = await landing(known, each, path);
      whole &&= isHere || each !== goesOnFrom;

      if (isHere && files().has(each)) {
        void ship(each, path);
      }
    }

    try {
      mkdirSync(folder, { recursive: true });
      follow(folder);
    } catch (error) {
      process.stderr.write(`hub: can't make ${folder}: ${String(error)}\n`);
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

    for (const declares of [true, false]) {
      for (const [session, path] of files()) {
        if (existsSync(path)) {
          await ship(session, path, declares);
        }
      }
    }
  }

  void catchUp();

  return { land };
}
