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
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import { awayFile, NOTHING } from "./store.ts";
import type { End, Piece } from "./store.ts";
import type { Threads } from "./threads.ts";

// The most text one row of the store holds, well under what a Durable Object takes in a row (https://developers.cloudflare.com/durable-objects/platform/limits/), and short enough on the wire that the hub's other calls, which wait their turn behind it, hardly wait. A send carries the whole lines that end within one, or one line however long.
const PIECE = 256 * 1024;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How much of a transcript's end is digested: each line carries its own id and time, so two files that agree here agree before it.
const TAIL = 4096;

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
// Claude Code may be midway through a line, so only whole ones count: those that end within a piece of where the store's copy ends, or the one line that runs past it.
function wholeLines(file: number, from: number, size: number) {
  for (let most = PIECE; ; most *= 2) {
    const bytes = Buffer.alloc(Math.min(size - from, most));
    readSync(file, bytes, 0, bytes.length, from);
    const whole = bytes.lastIndexOf(NEWLINE) + 1;

    if (whole > 0 || bytes.length === size - from) {
      return bytes.subarray(0, whole);
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

type More = { pieces: Piece[]; tail: string };

type Unsent = More | "behind" | "apart";

const goesOn = (more: Unsent): more is More => more !== "behind" && more !== "apart";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a machine's file holds past the store's copy. behind: the file is shorter, as on a machine another ran the session after. apart: the file doesn't hold the copy's end, so it's another conversation from some point on.
function unsent(path: string, end: End): Unsent {
  let file: number;

  try {
    file = openSync(path, "r");
  } catch {
    return "behind";
  }

  try {
    const { size } = fstatSync(file);

    if (size < end.size) {
      return "behind";
    }

    if (tailBefore(file, end.size) !== end.tail) {
      return "apart";
    }

    const bytes = wholeLines(file, end.size, size);

    return {
      pieces: pieces(bytes, end.size),
      tail: tailBefore(file, end.size + bytes.length),
    };
  } finally {
    closeSync(file);
  }
}

export type SessionTranscripts = ReturnType<typeof sessionTranscripts>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each open thread's conversation, in hex's store as Claude Code writes it, so its session resumes on whichever machine runs hex: Claude Code keeps a transcript only on the machine it runs on, and resumes only from that file. The hub that holds hex is the one writer of the store's copy, and sends what a transcript gained at each change to its file; a machine whose file isn't that copy grown longer takes the copy before the session starts. A store in this folder is on the only machine there is, so nothing is sent to one.
export function sessionTranscripts({
  threads,
  kept,
}: {
  threads: Pick<Threads, "ids" | "current" | "get" | "cwd">;
  kept: Keep;
}) {
  const ends = new Map<string, End>();
  const sending = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const behind = new Map<string, string>();
  const apart = new Set<string>();
  const watched = new Set<string>();
  const elsewhere = kept((store) => existsSync(awayFile(store.dir)), false);

  const held = () =>
    new Set(
      threads
        .ids()
        .flatMap((thread) => [threads.current(thread), threads.get(thread)?.session])
        .filter(present),
    );

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A send that finds the store not answering leaves its transcript owed until one gets through, since a session that then stays quiet changes its file no more.
  async function send(session: string, path: string) {
    for (;;) {
      const end =
        ends.get(session) ?? (await kept((store) => store.transcripts.end(session), undefined));

      if (end === undefined) {
        behind.set(session, path);

        return;
      }

      const more = unsent(path, end);

      if (!goesOn(more)) {
        ends.delete(session);

        if (more === "apart" && !apart.has(session)) {
          apart.add(session);
          process.stderr.write(
            `hub: ${path} isn't the conversation hex's store holds for ${session} grown longer, so the store keeps its own, which the session's next start takes\n`,
          );
        }

        return;
      }

      if (more.pieces.length === 0) {
        ends.set(session, end);
        behind.delete(session);
        sendOwed();

        return;
      }

      const now = await kept(
        (store) => store.transcripts.append(session, end, more.pieces, more.tail),
        undefined,
      );

      if (now === undefined) {
        ends.delete(session);
        behind.set(session, path);

        return;
      }

      ends.set(session, now);
    }
  }

  function sendOwed() {
    for (const [session, path] of behind) {
      behind.delete(session);
      void ship(session, path);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One send at a time for a transcript, and one more waiting however many changes come meanwhile, since a send takes all the file holds when it starts.
  function ship(session: string, path: string): Promise<void> {
    const before = sending.get(session) ?? Promise.resolve();

    if (queued.has(session)) {
      return before;
    }

    queued.add(session);

    const sent = (async () => {
      await before;
      queued.delete(session);

      try {
        await send(session, path);
      } catch (error) {
        process.stderr.write(`hub: couldn't send ${path} to hex's store: ${String(error)}\n`);
      }
    })();

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

      if (present(session) && held().has(session)) {
        void ship(session, join(folder, `${session}.jsonl`));
      }
    }).unref();
  }

  const pageAfter = (session: string, size: number) =>
    kept((store) => store.transcripts.since(session, size), []);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The store's copy, whole, in place of a file that isn't it grown longer, which is set aside under the name Claude Code gives a transcript it replaces. A copy that doesn't arrive whole leaves the machine as it was, for the start to go on as it does without a transcript.
  async function bring(session: string, to: string) {
    const end = await kept((store) => store.transcripts.end(session), NOTHING);
    const here = existsSync(to) ? to : claude.transcriptOf(session);

    if (end.size === 0 || (here !== undefined && goesOn(unsent(here, end)))) {
      return;
    }

    const path = here ?? to;
    const part = `${path}.arriving`;
    mkdirSync(dirname(path), { recursive: true });
    rmSync(part, { force: true });
    let size = 0;

    while (size < end.size) {
      const page = await pageAfter(session, size);
      const last = page.at(-1);

      if (last === undefined) {
        break;
      }

      appendFileSync(part, page.map(({ text }) => text).join(""));
      size = last.upto;
    }

    const arrived = unsent(part, end);

    if (size !== end.size || !goesOn(arrived) || arrived.pieces.length > 0) {
      rmSync(part, { force: true });
      process.stderr.write(
        `hub: ${session}'s conversation didn't arrive whole from hex's store, so this machine starts without it\n`,
      );

      return;
    }

    if (here !== undefined) {
      renameSync(here, `${here}.superseded-${Date.now()}`);
    }

    renameSync(part, path);
    ends.set(session, end);
    apart.delete(session);
    process.stderr.write(
      `hub: ${session}'s conversation came from hex's store, since ${here === undefined ? "this machine had none of it" : "this machine's file wasn't it"}\n`,
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Before a thread's session starts: the conversations it resumes or forks from are on this machine as the store holds them, and its folder is watched from here on.
  async function land(thread: string, fork?: string) {
    if (!(await elsewhere)) {
      return;
    }

    const known = threads.get(thread);
    const folder = claude.transcriptsIn(threads.cwd(thread));

    for (const session of new Set([known?.session, known?.fork, fork].filter(present))) {
      await bring(session, join(folder, `${session}.jsonl`));
    }

    mkdirSync(folder, { recursive: true });
    follow(folder);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // As the hub starts: what the store holds of sessions no open thread is on goes, and what the sessions wrote while no hub watched is sent, one transcript after another.
  async function catchUp() {
    if (!(await elsewhere)) {
      return;
    }

    await kept((store) => store.transcripts.prune(), 0);

    for (const thread of threads.ids()) {
      const folder = claude.transcriptsIn(threads.cwd(thread));
      follow(folder);

      for (const session of new Set([threads.current(thread), threads.get(thread)?.session])) {
        const path = join(folder, `${session}.jsonl`);

        if (present(session) && existsSync(path)) {
          await ship(session, path);
        }
      }
    }
  }

  void catchUp();

  return { land };
}
