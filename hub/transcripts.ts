import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import * as claude from "./claude.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import { awayFile, MARKS, NOTHING, RefusedError } from "./store.ts";
import type { End, Mark, Piece, Store } from "./store.ts";
import type { Threads } from "./threads.ts";

// The most text one row of the store holds, well under what a Durable Object takes in a row (https://developers.cloudflare.com/durable-objects/platform/limits/), and short enough on the wire that the hub's other calls, which wait their turn behind it, hardly wait. A send carries the whole lines that end within one, or one line however long.
const PIECE = 256 * 1024;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How much of a file's end is digested to tell, without reading the rest, that a file which grew still starts as it did: each line of a transcript carries its own id and time, so two files that agree here agree before it, unless one was changed in place with its length kept, which the digest of all of it shows whenever all of it is read.
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
const SESSION = 36;
const NEWLINE = 10;

const besideOf = (path: string) => join(path.slice(0, -".jsonl".length), BESIDE);

function entries(folder: string) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The files in a folder that are tool results. Claude Code keeps a PDF's pages in a folder of their own there, which is none.
function named(folder: string) {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && NAME.test(entry.name) && !entry.name.includes(ARRIVING))
      .map((entry) => entry.name);
  } catch {
    return [];
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

const digestOf = (hash: Hash) => hash.copy().digest("hex");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The hash of a file as it stands after each of these many of its bytes, shortest first. Its digest there is of every byte before, so two files that differ anywhere differ in every digest from there on, and the first one that differs says where.
function hashed(file: number, at: number[]) {
  const hash = createHash("sha256");
  const bytes = Buffer.alloc(4 * PIECE);
  let done = 0;

  return at.map((upto) => {
    while (done < upto) {
      const read = readSync(file, bytes, 0, Math.min(bytes.length, upto - done), done);

      if (read === 0) {
        break;
      }

      hash.update(bytes.subarray(0, read));
      done += read;
    }

    return hash.copy();
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code may be midway through a line, so a transcript counts as far as its last whole one.
function wholeLines(file: number, size: number) {
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

function bytesFrom(file: number, from: number, whole: number) {
  const bytes = Buffer.alloc(Math.min(whole - from, RAW));
  readSync(file, bytes, 0, bytes.length, from);

  return bytes;
}

function characters(bytes: Buffer) {
  const cut: Buffer[] = [];

  for (let at = 0; at < bytes.length;) {
    let end = Math.min(at + PIECE, bytes.length);

    // oxlint-disable-next-line no-bitwise -- a UTF-8 byte that continues a character, which a piece never ends inside
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }

    cut.push(bytes.subarray(at, end));
    at = end;
  }

  return cut;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The two kinds of file the store holds a copy of. A transcript grows by whole lines and goes as its text; a file cut short of its copy is that copy's start, as one put back from a backup is, and the copy completes it. A file beside a transcript, which may be an image, goes in base64 to its last byte, and is whole however long it is.
type Kind = {
  grows: boolean;
  whole: (file: number, size: number) => number;
  read: (file: number, from: number, whole: number) => Buffer;
  cut: (bytes: Buffer) => Buffer[];
  text: (bytes: Buffer) => string;
  bytes: (text: string) => Buffer;
};

const LINES: Kind = {
  grows: true,
  whole: wholeLines,
  read: linesFrom,
  cut: characters,
  text: (bytes) => bytes.toString("utf-8"),
  bytes: (text) => Buffer.from(text, "utf-8"),
};

const BYTES: Kind = {
  grows: false,
  whole: (_file, size) => size,
  read: bytesFrom,
  cut: (bytes) => (bytes.length === 0 ? [] : [bytes]),
  text: (bytes) => bytes.toString("base64"),
  bytes: (text) => Buffer.from(text, "base64"),
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether a file is the conversation a copy is of: it holds the end of the file the copy was last sent from, which the copy itself may still be short of.
function isItsFile(path: string, { of, last }: End) {
  try {
    const file = openSync(path, "r");

    try {
      return fstatSync(file).size >= of && tailBefore(file, of) === last;
    } finally {
      closeSync(file);
    }
  } catch {
    return false;
  }
}

type Ask = <T>(use: (store: Store) => Promise<T>) => Promise<T | undefined>;

type Saw = { ino: number; size: number; mtimeMs: number };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A file as a hub last found it to hold the store's copy: where that copy stood, and the hash of the file up to there, which the next lines go on from. A file that only grew since is not read again.
type Seen = Saw & { end: End; hash: Hash };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a hub knows of the copies, and how it asks the store (ask), whose client lets a conversation's calls leave at once: each conversation's sends go one after another, so the conversations send side by side, and a session's start waits behind none of them. root: where this machine keeps, for each file, the last state in which the file and its copy were the same, which says which of the two changed since. heard: where the store last said each transcript stands. there: the files beside each transcript that the store holds, and where each stands. written: the sessions whose transcript changed on this machine under this hub, which holds hex, so no other machine has more of them. beside: watches the files beside a transcript.
type Known = {
  ask: Ask;
  machine: string;
  root: string;
  seen: Map<string, Seen>;
  heard: Map<string, End>;
  there: Map<string, Map<string, End>>;
  written: Set<string>;
  beside: (session: string, path: string) => void;
};

type Copy = [key: string, path: string];

const AGREED = /^(?<size>\d+) (?<digest>[\da-f]{64})$/u;

function textOf(path: string) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function agreedOn(root: string, key: string) {
  const said = AGREED.exec(textOf(join(root, `${key}.agreed`)))?.groups;

  return said && { size: Number(said.size), digest: said.digest ?? "" };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// This machine's file holds the copy as it stands: said after the store took a send or gave the copy, so what is written is true of some moment, whenever the hub stops. A copy with no digest is one nobody read whole, and agrees with nothing.
function agree(root: string, key: string, { size, digest }: End) {
  if (digest === NOTHING.digest) {
    return;
  }

  try {
    const to = join(root, `${key}.agreed`);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, `${size} ${digest}`);
  } catch (error) {
    process.stderr.write(`hub: can't keep where ${key} and its copy agreed: ${String(error)}\n`);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How a file stands to the store's copy of it. same, ahead: the file holds the copy, and more when ahead. newer: the file wins from `from` on, where the two first differ and the copy's digest is `starts`, once it has, onto its whole lines, what the copy gained from `gain.from` on. older: the copy wins from `from` on; own: the file changed or grew since it last agreed with the copy, so it may hold what the copy doesn't, and is kept aside unless it turns out to be the copy's start. saw: the file as it was looked at, none when there is none.
type View =
  | { is: "same" | "ahead"; hash: Hash; ino: number }
  | { is: "newer"; from: number; starts: string; gain?: { from: number; onto: number }; saw: Saw }
  | { is: "older"; from: number; own: boolean; saw: Saw | undefined };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a look is for. brings: the copy comes where it is the newer, so where the two first differ is asked for even when which is newer is plain without it. whole: the file is read whole though it looks to have only grown since it was last read.
type Looking = { brings?: boolean; whole?: boolean };

async function marked(ask: Ask, key: string) {
  const marks: Mark[] = [];

  for (;;) {
    const page = await ask((store) => store.transcripts.marks(key, marks.at(-1)?.upto ?? 0));

    if (page === undefined) {
      return page;
    }

    marks.push(...page);

    if (page.length < MARKS) {
      return marks;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The pieces of a copy past so many of its bytes, a page a call, each as it comes; whether they ran as far as asked.
async function pieces(
  ask: Ask,
  [key, kind]: [string, Kind],
  [from, upto]: [number, number],
  each: (bytes: Buffer) => void,
) {
  for (let size = from; size < upto;) {
    const at = size;
    const page = (await ask((store) => store.transcripts.since(key, at))) ?? [];
    const last = page.at(-1);

    if (last === undefined) {
      return false;
    }

    for (const { text } of page) {
      each(kind.bytes(text));
    }

    size = last.upto;
  }

  return true;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether what a file holds past so many bytes is how the copy goes on from there, as far as the file goes: then the file is the copy cut short. Nothing: the store didn't give that much of the copy.
async function startsCopy(
  ask: Ask,
  copy: [string, Kind],
  file: number,
  [from, whole]: [number, number],
) {
  let [at, starts] = [from, true];

  const came = await pieces(ask, copy, [from, whole], (bytes) => {
    const mine = Buffer.alloc(Math.min(bytes.length, Math.max(0, whole - at)));
    readSync(file, mine, 0, mine.length, at);
    starts &&= mine.equals(bytes.subarray(0, mine.length));
    at += bytes.length;
  });

  return came ? starts : undefined;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a file and its copy first differ: the end of the last of the copy's pieces up to which the file's digest is the copy's (upto, digest), and the piece after it. Nothing: the store didn't say.
async function apart(ask: Ask, key: string, file: number, whole: number) {
  const marks = await marked(ask, key);

  if (marks === undefined) {
    return marks;
  }

  const here = hashed(
    file,
    marks.map(({ upto }) => upto).filter((upto) => upto <= whole),
  );

  const differs = marks.findIndex(({ digest }, at) => {
    const hash = here[at];

    return hash === undefined || digestOf(hash) !== digest;
  });

  const kept = differs === -1 ? marks.length : differs;

  return { marks, next: marks[kept], ...(marks[kept - 1] ?? { upto: 0, digest: "" }) };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Which of a file and its copy is the newer, where the file doesn't hold the copy: the one that changed since they last agreed. Changed both, or never known to agree, the machine that last sent the copy has the newer. A transcript that is the copy's start is completed by it, whoever changed, as a file put back from a backup is.
async function differing(
  ask: Ask,
  { machine, root }: Known,
  [key, kind]: [string, Kind],
  [file, saw]: [number, Saw],
  [end, brings]: [End, boolean],
): Promise<View | undefined> {
  const whole = kind.whole(file, saw.size);
  const agreed = agreedOn(root, key);
  const [base] = hashed(file, agreed !== undefined && agreed.size <= whole ? [agreed.size] : []);
  const mine = agreed !== undefined && base !== undefined && digestOf(base) === agreed.digest;
  const own = agreed !== undefined && !(mine && agreed.size === whole);
  const wins = end.by !== machine && (agreed === undefined || mine);

  if (wins && !(brings && kind.grows)) {
    return { is: "older", from: 0, own, saw };
  }

  const at = await apart(ask, key, file, whole);

  if (at === undefined) {
    return at;
  }

  const { upto: from, digest: starts, next, marks } = at;

  if (wins) {
    return { is: "older", from, own, saw };
  }

  if (kind.grows && whole < (next?.upto ?? 0)) {
    const isItsStart = whole === from || (await startsCopy(ask, [key, kind], file, [from, whole]));

    if (isItsStart === undefined || isItsStart) {
      return isItsStart && { is: "older", from, own: false, saw };
    }
  }

  const theirs =
    agreed !== undefined &&
    marks.some(({ upto, digest }) => upto === agreed.size && digest === agreed.digest);

  if (theirs && !mine) {
    return {
      is: "newer",
      from,
      starts,
      ...(end.size > agreed.size && { gain: { from: agreed.size, onto: whole } }),
      saw,
    };
  }

  return end.by === machine && !(mine && !theirs)
    ? { is: "newer", from, starts, saw }
    : { is: "older", from, own, saw };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How a file stands to the store's copy, by what both hold: a file that only grew since it was last found to hold the copy holds it still, and any other is read whole. Nothing: the store didn't say what it holds.
async function look(
  ask: Ask,
  known: Known,
  [key, path]: Copy,
  kind: Kind,
  [end, { brings = false, whole: rereads = false } = {}]: [End, Looking?],
): Promise<View | undefined> {
  let file: number;

  try {
    file = openSync(path, "r");
  } catch {
    return { is: "older", from: 0, own: false, saw: undefined };
  }

  try {
    const { ino, size, mtimeMs } = fstatSync(file);
    const saw = { ino, size, mtimeMs };
    const whole = kind.whole(file, size);
    const is = whole === end.size ? "same" : "ahead";
    const was = known.seen.get(key);

    if (
      !rereads &&
      was?.ino === ino &&
      was.end.size === end.size &&
      was.end.digest === end.digest &&
      ((was.size === size && was.mtimeMs === mtimeMs) ||
        (kind.grows && size > was.size && tailBefore(file, end.size) === end.tail))
    ) {
      known.seen.set(key, { ...was, ...saw });

      return { is, hash: was.hash, ino };
    }

    known.seen.delete(key);

    const [hash] = hashed(file, end.size <= whole ? [end.size] : []);

    if (hash !== undefined && (end.size === 0 || digestOf(hash) === end.digest)) {
      known.seen.set(key, { ...saw, end, hash });
      agree(known.root, key, end);

      return { is, hash, ino };
    }

    return await differing(ask, known, [key, kind], [file, saw], [end, brings]);
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
// A new file that starts as another does, for so many bytes, and the hash of those.
function startedAs(path: string, part: string, upto: number) {
  const hash = createHash("sha256");
  writeFileSync(part, "");

  if (upto > 0) {
    const [from, to] = [openSync(path, "r"), openSync(part, "a")];
    const bytes = Buffer.alloc(4 * PIECE);

    try {
      for (let done = 0; done < upto;) {
        const read = readSync(from, bytes, 0, Math.min(bytes.length, upto - done), done);

        if (read === 0) {
          break;
        }

        writeSync(to, bytes, 0, read);
        hash.update(bytes.subarray(0, read));
        done += read;
      }
    } finally {
      closeSync(from);
      closeSync(to);
    }
  }

  return hash;
}

function isAsSeen(path: string, saw: Saw | undefined) {
  try {
    const { ino, size, mtimeMs } = statSync(path);

    return saw?.ino === ino && saw.size === size && saw.mtimeMs === mtimeMs;
  } catch {
    return saw === undefined;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether every byte a file has is another's, from its first.
function startsAs(short: string, long: string) {
  const [one, other] = [openSync(short, "r"), openSync(long, "r")];

  try {
    const [mine, theirs] = [Buffer.alloc(PIECE), Buffer.alloc(PIECE)];

    for (let at = 0, read = PIECE; read === PIECE; at += PIECE) {
      read = readSync(one, mine, 0, PIECE, at);

      if (
        readSync(other, theirs, 0, read, at) !== read ||
        !mine.subarray(0, read).equals(theirs.subarray(0, read))
      ) {
        return false;
      }
    }

    return true;
  } finally {
    closeSync(one);
    closeSync(other);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store's copy takes a file's place from where the two first differ: what the file holds before that, then the copy's pieces, checked whole against the copy's digest before it takes the file's name, by which the copy's every byte is known to have come, and the file's start to be the copy's. A transcript that changed or grew since it last agreed with the copy, and isn't the start of what came, is kept beside it: the only place its lines are. One that is what the two last agreed on, or never agreed with a copy, holds nothing known to be its own, and goes. moved: the file changed while the copy came, so it is looked at again.
async function bring(
  ask: Ask,
  { root, seen }: Known,
  [key, path]: Copy,
  kind: Kind,
  [end, view]: [End, Extract<View, { is: "older" }>],
) {
  const part = arrivingAt(path);

  try {
    const hash = startedAs(path, part, view.from);

    const came = await pieces(ask, [key, kind], [view.from, end.size], (bytes) => {
      appendFileSync(part, bytes);
      hash.update(bytes);
    });

    const whole = came && (end.size === 0 || digestOf(hash) === end.digest);

    if (!whole) {
      process.stderr.write(`hub: ${key} didn't arrive whole from hex's store\n`);

      return false;
    }

    if (!isAsSeen(path, view.saw)) {
      return "moved";
    }

    if (kind.grows && view.own && view.saw !== undefined && !startsAs(path, part)) {
      renameSync(path, `${path}.set-aside-${Date.now()}`);
    }

    renameSync(part, path);
    const { ino, size, mtimeMs } = statSync(path);
    seen.set(key, { ino, size, mtimeMs, end, hash });
    agree(root, key, end);

    process.stderr.write(
      `hub: ${key} came from hex's store, since ${view.saw === undefined ? "this machine had none of it" : "the store's is the newer"}\n`,
    );

    return true;
  } finally {
    rmSync(part, { force: true });
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A file changed in place on this machine, while another machine's lines went on reaching the copy, gets those lines on its end before it is sent: they are in no file here, and the send puts the file in the copy's place. From then the file is said to agree with the copy as it stands, which it holds all of but for its own change, so the lines come once.
async function gained(
  ask: Ask,
  { root }: Known,
  [key, path]: Copy,
  [end, { gain, saw }]: [End, { gain: { from: number; onto: number }; saw: Saw }],
) {
  const more: Buffer[] = [];

  const came = await pieces(ask, [key, LINES], [gain.from, end.size], (bytes) => {
    more.push(bytes);
  });

  if (!came) {
    return false;
  }

  const part = arrivingAt(path);

  try {
    startedAs(path, part, gain.onto);
    appendFileSync(part, Buffer.concat(more));

    if (!isAsSeen(path, saw)) {
      return "moved";
    }

    renameSync(part, path);
    agree(root, key, end);

    return true;
  } finally {
    rmSync(part, { force: true });
  }
}

type More = { pieces: Piece[]; over: number | false; upto: number; hash: Hash; saw: Saw } & Pick<
  End,
  "tail" | "digest" | "of" | "last"
>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a file sends its copy, as the pieces of one send, each with the digest of the file up to its end: from the copy's end, for a file that holds the copy, and from where the two first differ for a newer one, whose copy then keeps only so many of its bytes (over). lines: none, to only say how long the file is. Nothing: the file isn't there, or no longer starts as the copy does up to there, having changed since it was looked at.
function past(
  path: string,
  kind: Kind,
  [end, view]: [End, Exclude<View, { is: "older" }>],
  lines: boolean,
) {
  let file: number;

  try {
    file = openSync(path, "r");
  } catch {
    return;
  }

  try {
    const { ino, size, mtimeMs } = fstatSync(file);
    const of = kind.whole(file, size);
    const from = view.is === "newer" ? view.from : end.size;
    const hash = view.is === "newer" ? hashed(file, [from])[0] : view.hash.copy();

    const starts =
      view.is === "newer"
        ? from === 0 || (hash !== undefined && digestOf(hash) === view.starts)
        : ino === view.ino && tailBefore(file, from) === end.tail;

    if (of < from || hash === undefined || !starts) {
      return;
    }

    let upto = from;

    const cut = kind.cut(lines ? kind.read(file, from, of) : Buffer.alloc(0)).map((bytes) => {
      hash.update(bytes);
      upto += bytes.length;

      return { upto, text: kind.text(bytes), digest: digestOf(hash) };
    });

    const more: More = {
      pieces: cut,
      over: view.is === "newer" && from,
      upto,
      hash,
      saw: { ino, size, mtimeMs },
      tail: tailBefore(file, upto),
      digest: digestOf(hash),
      of,
      last: kind.grows ? tailBefore(file, of) : NOTHING.last,
    };

    return more;
  } finally {
    closeSync(file);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One send of a file to its copy, which lands only where the copy stood as this hub read it. full: the store has no room left for transcripts, which it says by refusing. Where the copy stands now, and whether that is where this send left it: then the file holds the copy, and says so.
async function appended(
  { ask, machine, root, seen }: Known,
  key: string,
  [end, more]: [End, More],
) {
  const now = await ask(async (store) => {
    try {
      return await store.transcripts.append(
        key,
        end,
        more.pieces,
        { tail: more.tail, digest: more.digest, of: more.of, last: more.last, by: machine },
        more.over,
      );
    } catch (error) {
      if (!(error instanceof RefusedError)) {
        throw error;
      }

      process.stderr.write(
        `hub: ${error.message}; until the hub next starts the store is told only how long each transcript is\n`,
      );

      return "full" as const;
    }
  });

  if (now === undefined || now === "full") {
    seen.delete(key);

    return now;
  }

  const took =
    now.by === machine &&
    now.size === more.upto &&
    now.of === more.of &&
    (now.size === 0 || now.digest === more.digest);

  if (took) {
    seen.set(key, { ...more.saw, end: now, hash: more.hash });
    agree(root, key, now);
  } else {
    seen.delete(key);
  }

  return { now, took };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A send that the copy didn't take as read is tried again from where the copy stands now, this many times before it waits for the file's next change.
const TRIES = 3;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One file beside a transcript and the store's copy of it, made the same: the newer of the two takes the other's place, and a file this machine has none of comes. Where the copy stands then; false for a file that can't be settled now, which holds up nothing else; nothing when the store didn't answer.
async function settled(known: Known, file: Copy, stands: End) {
  let end = stands;

  for (let tries = 0; tries < TRIES;) {
    const view = await look(known.ask, known, file, BYTES, [end]);

    if (view === undefined) {
      return view;
    }

    if (view.is === "same") {
      return end;
    }

    if (view.is === "older") {
      const came = end.size === end.of && (await bring(known.ask, known, file, BYTES, [end, view]));

      if (came !== "moved") {
        return came && end;
      }

      tries += 1;
      continue;
    }

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Another machine's copy, short of the file it was sending: only that file completes it.
    if (view.is !== "newer" && end.size < end.of && end.by !== known.machine) {
      return false;
    }

    const more = past(file[1], BYTES, [end, view], true);

    if (more === undefined) {
      known.seen.delete(file[0]);
      tries += 1;
      continue;
    }

    const landed = await appended(known, file[0], [end, more]);

    if (landed === undefined || landed === "full") {
      return landed;
    }

    tries = landed.took ? 0 : tries + 1;
    end = landed.now;
  }

  return false;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The files beside a transcript, here and in the store, made the same, and their folder watched from here on. The store is asked what it holds of a session once a hub: nothing else changes it while this hub holds hex. Nothing: the store didn't answer.
async function besidesSettled(known: Known, session: string, path: string) {
  const folder = besideOf(path);
  let held = known.there.get(session);

  if (held === undefined) {
    const listed = await known.ask((store) => store.transcripts.besides(session));

    if (listed === undefined) {
      return listed;
    }

    held = new Map(
      listed.flatMap(({ file, ...end }) => {
        const name = file.slice(BESIDE.length + 1);

        return file === `${BESIDE}/${name}` && NAME.test(name) ? [[name, end] as const] : [];
      }),
    );
    known.there.set(session, held);
  }

  known.beside(session, path);

  for (const name of new Set([...named(folder), ...held.keys()])) {
    const now = await settled(
      known,
      [`${session}/${BESIDE}/${name}`, join(folder, name)],
      held.get(name) ?? NOTHING,
    );

    if (now === undefined || now === "full") {
      return now;
    }

    if (now !== false) {
      held.set(name, now);
    }
  }

  return true;
}

const underWay = new Set<Promise<void>>();

const rereading = new Set<() => void>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the files hold is in the store. A hub that stops waits for this, since the sessions it leaves are frozen by then and the next hub may be on another machine, where a session resumes only from a whole copy: every transcript a hub found to hold its copy is read whole once more, since one that only grew was known by its end, and the sends under way are done. Nothing else waits on a send, which is as long as what a session wrote.
export async function sent() {
  for (const reread of rereading) {
    reread();
  }

  await Promise.all(underWay);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How a send goes, when not as any: it only says how long the file is (declares), or reads the file whole first though it looks to have only grown (rereads).
type How = "declares" | "rereads" | undefined;

type Send = (session: string, path: string, how: How) => Promise<void>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One send at a time for a transcript, and one more waiting however many changes come meanwhile, since a send takes all the file holds when it starts. A send that declares or rereads waits its turn like any.
function shipping(send: Send) {
  const sending = new Map<string, Promise<void>>();
  const queued = new Set<string>();

  return function ship(session: string, path: string, how?: How): Promise<void> {
    const before = sending.get(session) ?? Promise.resolve();

    if (how === undefined && queued.has(session)) {
      return before;
    }

    if (how === undefined) {
      queued.add(session);
    }

    const shipped = (async () => {
      await before;

      if (how === undefined) {
        queued.delete(session);
      }

      try {
        await send(session, path, how);
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
// A watch holds no process open: the hub's exit ends it. A folder that can't be watched, as on a machine out of watches, is still looked at each time a hub or a session starts.
function watching() {
  const watched = new Set<string>();

  return function follow(folder: string, changed: (name: string) => void) {
    if (watched.has(folder) || !existsSync(folder)) {
      return;
    }

    try {
      watch(folder, (_change, name) => {
        changed(name ?? "");
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
// Whether this machine holds a session's whole conversation, as new as the store's, for which its file is read whole. A file the copy is newer than, or longer than, gets what it lacks from the copy before the session starts; one that is the newer stays, and is sent behind the start. A store that holds nothing of a session says nothing against the file here. One that doesn't answer leaves what it last said of the session to this hub, or that the session wrote here under this hub: without either, the file here may be an older one, and isn't resumed. A copy still short of the file it is of completes nothing.
async function brought(known: Known, session: string, to: string) {
  const { ask, machine, heard, written } = known;
  const end = (await ask((store) => store.transcripts.end(session))) ?? heard.get(session);
  const file: Copy = [session, existsSync(to) ? to : (claude.transcriptOf(session) ?? to)];

  if (end === undefined) {
    process.stderr.write(
      `hub: hex's store didn't say where ${session}'s conversation stands, so it ${written.has(session) ? "goes on from this machine's file, which it wrote under this hub" : "isn't resumed from this machine's file"}\n`,
    );

    return written.has(session) && existsSync(file[1]);
  }

  heard.set(session, end);

  if (end.of === 0) {
    return true;
  }

  for (let tries = 0; tries < TRIES; tries += 1) {
    const view = await look(ask, known, file, LINES, [end, { brings: true, whole: true }]);

    if (view === undefined) {
      return false;
    }

    if (view.is !== "older" && view.is !== "newer") {
      return end.by === machine || isItsFile(file[1], end);
    }

    if (view.is === "older" && end.size < end.of) {
      return false;
    }

    const came =
      view.is === "older"
        ? await bring(ask, known, file, LINES, [end, view])
        : view.gain === undefined ||
          (await gained(ask, known, file, [end, { gain: view.gain, saw: view.saw }]));

    if (came !== "moved") {
      return came;
    }
  }

  return false;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session's conversation, here as the store holds it. A landing that fails, as on a disk with no room, leaves no whole conversation here that anything shows.
async function landing(known: Known, session: string, path: string) {
  try {
    return await brought(known, session, path);
  } catch (error) {
    process.stderr.write(
      `hub: ${session}'s conversation couldn't be brought from hex's store: ${String(error)}\n`,
    );

    return false;
  }
}

export type SessionTranscripts = ReturnType<typeof sessionTranscripts>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each open thread's conversation, in hex's store as Claude Code writes it, with the tool results beside it, so its session resumes on whichever machine runs hex: Claude Code keeps them only on the machine it runs on, and resumes only from them. A file and its copy are compared by what they hold, a digest for each piece of the copy, and each machine keeps the last state in which its file was the copy: whichever of the two changed since is the newer, and takes the other's place from where they first differ. So a hub sends what a file gained at each change, the tool results before the lines that name them, and what was changed in place, on either machine, stays changed in both. A hub on another machine takes the copy before the session starts, and resumes the session only with the whole conversation on its disk: a copy still short of its file isn't one, and neither is a file the store can't be asked about. A thread that starts every turn fresh resumes nothing, and a store in this folder is on the only machine there is, so neither is sent.
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
  const holds = new Map<string, string>();
  const follow = watching();
  let full = false;

  const home = kept(
    (store) => (existsSync(awayFile(store.dir)) ? join(store.dir, "copies", machine) : undefined),
    undefined,
  );

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

  const known: Known = {
    ask: (use) => kept(use, undefined),
    machine,
    root: "",
    seen: new Map(),
    heard: new Map(),
    there: new Map(),
    written: new Set(),
    beside,
  };

  const { ask, seen, heard } = known;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A transcript, and what is beside it, sent as far as this machine's are the newer; one the copy is newer than waits for its session's start, which brings it. declares: says whose file the copy is and how long it is, and sends none of it, so a copy is known to be short before the first of its bytes go; all a store with no room left is told. What was changed in place leaves the copy with that, before anything is sent. A line that names a file beside the transcript was written after that file, so the files beside it are settled before its lines go.
  async function send(session: string, path: string, how: How) {
    const file: Copy = [session, path];
    const declares = how === "declares";
    let end = seen.get(session)?.end;

    for (let tries = 0; tries < TRIES;) {
      end ??= await ask((store) => store.transcripts.end(session));

      if (end === undefined) {
        break;
      }

      heard.set(session, end);
      const view = await look(ask, known, file, LINES, [end, { whole: how === "rereads" }]);
      const theirs = end.by !== machine && end.by !== NOTHING.by;

      if (view === undefined) {
        break;
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // Another machine's copy, short of a file that this one isn't: this file is an older state of that conversation, or another one from some line on, and adds nothing to the copy.
      if (view.is === "older" || (view.is !== "newer" && theirs && !isItsFile(path, end))) {
        holds.delete(session);

        return;
      }

      holds.set(session, path);

      const has =
        view.is !== "newer" ||
        view.gain === undefined ||
        (await gained(ask, known, file, [end, { gain: view.gain, saw: view.saw }]));

      const besides =
        has === true && (declares || full || (await besidesSettled(known, session, path)));

      if (besides === "full") {
        full = true;
        continue;
      }

      if (besides !== true) {
        break;
      }

      const more = past(path, LINES, [end, view], !(declares || full));

      if (more === undefined) {
        seen.delete(session);
        tries += 1;
        continue;
      }

      const said = theirs ? view.is === "same" : end.of === more.of && end.last === more.last;

      if (more.over === false && more.pieces.length === 0 && said) {
        owed.delete(session);

        return;
      }

      const landed = await appended(known, session, [end, more]);

      if (landed === undefined) {
        break;
      }

      if (landed === "full") {
        full = true;
        continue;
      }

      tries = landed.took ? 0 : tries + 1;
      end = landed.now;
    }

    owed.set(session, path);
  }

  const ship = shipping(send);

  rereading.add(() => {
    for (const [session, path] of holds) {
      void ship(session, path, "rereads");
    }
  });

  function beside(session: string, path: string) {
    follow(besideOf(path), (name) => {
      if (NAME.test(name) && !name.includes(ARRIVING) && files().has(session)) {
        void ship(session, path);
      }
    });
  }

  function following(folder: string) {
    follow(folder, (name) => {
      const session = TRANSCRIPT.exec(name)?.groups?.session;

      if (present(session) && files().has(session)) {
        known.written.add(session);
        void ship(session, join(folder, `${session}.jsonl`));
      }
    });
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
  // Before a thread's session starts: the conversations it resumes or forks from are on this machine as new as the store holds them, and its folder is watched from here on. Whether the one this start goes on from, the thread's own or the one it forks, is whole here: one this machine holds only part of can't be resumed or forked. What this machine has that the store lacks, and the files beside each, follow behind the start.
  async function land(thread: string, fork?: string) {
    const root = await home;

    if (root === undefined) {
      return true;
    }

    known.root = root;
    const session = fresh(thread) ? undefined : threads.get(thread);
    const goesOnFrom = fork ?? session?.session ?? session?.fork;
    const folder = claude.transcriptsIn(threads.cwd(thread));
    let whole = true;

    for (const each of new Set([session?.session, session?.fork, fork].filter(present))) {
      const path = join(folder, `${each}.jsonl`);
      const isHere = await landing(known, each, path);
      whole &&= isHere || each !== goesOnFrom;

      if (isHere) {
        void ship(each, path);
      }
    }

    try {
      mkdirSync(folder, { recursive: true });
      following(folder);
    } catch (error) {
      process.stderr.write(`hub: can't make ${folder}: ${String(error)}\n`);
    }

    return whole;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // As the hub starts: what the store holds of sessions no open thread is on goes, and what this machine keeps of them, whichever of this machine's hubs the thread is on. Then every transcript is read whole against its copy, and the store told how long each is, before what the sessions wrote while no hub watched is sent, one transcript after another. One whose copy is the newer has nothing to send, and waits for its session's start.
  async function catchUp() {
    const root = await home;

    if (root === undefined) {
      return;
    }

    known.root = root;
    void kept((store) => store.watch(sendOwed), ignore);
    await ask((store) => store.transcripts.prune());

    const open = await ask((store) => store.threads.list({ open: true }));

    const held = new Set([
      ...threads.ids().map((thread) => threads.current(thread)),
      ...(open ?? []).flatMap((thread) => [thread.session, thread.fork]),
    ]);

    for (const name of open === undefined ? [] : entries(root)) {
      if (!held.has(name.slice(0, SESSION))) {
        rmSync(join(root, name), { recursive: true, force: true });
      }
    }

    for (const thread of threads.ids()) {
      following(claude.transcriptsIn(threads.cwd(thread)));
    }

    for (const declares of [true, false]) {
      for (const [session, path] of files()) {
        if (existsSync(path) && (declares || holds.has(session))) {
          await ship(session, path, declares ? "declares" : undefined);
        }
      }
    }

    process.stderr.write(
      `hub: ${files().size} conversations compared with hex's store: ${holds.size} are there as they are here, ${owed.size} are owed to it\n`,
    );
  }

  void catchUp();

  return { land };
}
