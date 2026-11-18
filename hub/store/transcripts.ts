import { z } from "zod";

import type { Core, Sql, Write } from "./db.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where the store's copy of a file stands. size, tail: how many of the file's bytes it holds, and a digest of the last of them, by which a machine tells whether its own file goes on from there. by: the machine whose file it is a copy of. of, last: how long that file's whole lines were when that machine last said, and a digest of the last of those, so a copy shorter than that is known to be short of its conversation, and another machine's file to be that conversation or not. A file the store holds nothing of stands at nothing.
export type End = { size: number; tail: string; of: number; last: string; by: string };

export const NOTHING: End = { size: 0, tail: "", of: 0, last: "", by: "" };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A stretch of a file and the byte it ends before: a transcript's as its text, and a file beside one's, which may be an image, as base64.
export type Piece = { upto: number; text: string };

const Stands = z.object({
  size: z.number(),
  tail: z.string(),
  of: z.number(),
  last: z.string(),
  by: z.string(),
});

const EndRow = Stands.nullable();
const Besides = z.array(Stands.extend({ file: z.string() }));

const PieceRows = z.array(z.object({ upto: z.number(), text: z.string() }));
const Held = z.object({ held: z.number() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What one reply carries of a transcript, so a long one crosses the network a page at a time.
const PAGE = 2 * 1024 * 1024;

// Half of what a Durable Object holds (https://developers.cloudflare.com/durable-objects/platform/limits/), counted in the files' own bytes, so the copies never fill it, base64 and all: an object that is full refuses every write, hex's records too.
const ROOM = 5 * 1024 * 1024 * 1024;

const same = (one: End, other: End) =>
  one.size === other.size &&
  one.tail === other.tail &&
  one.of === other.of &&
  one.last === other.last &&
  one.by === other.by;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session's id is this long, and what Claude Code keeps beside its transcript is held as `<session>/<path>`.
const SESSION = 36;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The transcripts of the sessions open threads are on, and the tool results Claude Code keeps beside each, as it wrote them on the machine that ran each, so the session carries on from any machine that reaches the store. They are copies of files a machine holds, not records: their tables are the home's own, made by the first call that needs them, which no move or backup of the records carries, and a write to them tells no watcher (quiet), since a transcript grows with every line of every session.
export class Transcripts {
  private readonly db: Sql;
  private readonly quiet: Write;
  private made = false;

  constructor({ db }: Core, quiet: Write) {
    this.db = db;
    this.quiet = quiet;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Not a method, so the store doesn't offer it as a call.
  private readonly tables = () => {
    if (this.made) {
      return;
    }

    this.db.run(
      "create table if not exists _transcripts (session text not null, upto integer not null, text text not null, primary key (session, upto))",
    );
    this.db.run(
      'create table if not exists _transcript_ends (session text primary key, size integer not null, tail text not null, "of" integer not null, last text not null, by text not null)',
    );
    this.made = true;
  };

  end(session: string): End {
    this.tables();

    return (
      EndRow.parse(
        this.db
          .query('select size, tail, "of", last, by from _transcript_ends where session = ?')
          .get(session),
      ) ?? NOTHING
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Lands only where the sender read the copy to stand, so one sent twice, or by a machine another has taken the copy from since, changes nothing. No pieces only says whose file the copy is and how long that file is. over: the copy starts over from these pieces, for a file its own machine changed in place. Answers where the copy stands now.
  append(
    session: string,
    after: End,
    pieces: Piece[],
    to: Pick<End, "tail" | "of" | "last" | "by">,
    over = false,
  ): End {
    return this.quiet(() => {
      const end = this.end(session);

      if (!same(end, after)) {
        return end;
      }

      const from = over ? 0 : end.size;
      const size = pieces.at(-1)?.upto ?? from;

      const { held } = Held.parse(
        this.db.query("select coalesce(sum(size), 0) as held from _transcript_ends").get(),
      );

      if (held - end.size + size > ROOM) {
        throw new Error(
          `hex's store keeps ${ROOM} bytes of transcripts at most, and holds ${held}: closing threads frees it`,
        );
      }

      if (over) {
        this.db.query("delete from _transcripts where session = ?").run(session);
      }

      const insert = this.db.query(
        "insert into _transcripts (session, upto, text) values (?, ?, ?)",
      );

      for (const { upto, text } of pieces) {
        insert.run(session, upto, text);
      }

      const now = { ...to, size, tail: size === 0 ? NOTHING.tail : to.tail };

      this.db
        .query(
          'insert into _transcript_ends (session, size, tail, "of", last, by) values (?1, ?2, ?3, ?4, ?5, ?6) on conflict (session) do update set size = ?2, tail = ?3, "of" = ?4, last = ?5, by = ?6',
        )
        .run(session, now.size, now.tail, now.of, now.last, now.by);

      return now;
    });
  }

  since(session: string, from: number): Piece[] {
    this.tables();

    return PieceRows.parse(
      this.db
        .query(
          "select upto, text from _transcripts where session = ? and upto > ? and upto <= ? order by upto",
        )
        .all(session, from, from + PAGE),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The files beside a session's transcript that the store holds a copy of, each with where its copy stands.
  besides(session: string) {
    this.tables();

    return Besides.parse(
      this.db
        .query(
          `select substr(session, ${SESSION + 2}) as file, size, tail, "of", last, by from _transcript_ends where session > ?1 || '/' and session < ?1 || '0' order by session`,
        )
        .all(session),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Only a session an open thread is on, or forks from, is ever resumed, so the rest go, with what was beside them: the machine that ran one keeps its files. Answers how many files went.
  prune(): number {
    return this.quiet(() => {
      this.tables();

      const unheld = `substr(session, 1, ${SESSION}) not in (select session from threads where open = 1 and session is not null union select fork from threads where open = 1 and fork is not null)`;

      this.db
        .query(
          `delete from _transcripts where session in (select session from _transcript_ends where ${unheld})`,
        )
        .run();

      return this.db.query(`delete from _transcript_ends where ${unheld}`).run().changes;
    });
  }
}
