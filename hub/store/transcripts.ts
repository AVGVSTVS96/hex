import { z } from "zod";

import type { Core, Sql, Write } from "./db.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where the store's copy of a file stands. size, digest: how many of the file's bytes it holds, and a digest of all of them, by which a machine tells whether its own file is the copy, or goes on from it. tail: a digest of the last of them, all that a hub before digests said, so a copy with no digest is one whose bytes nobody vouches for. by: the machine that last sent some of it. of, last: how long that machine's file was in whole lines when it last said, and a digest of the last of those, so a copy shorter than that is known to be short of its conversation, and another machine's file to be that conversation or not. A file the store holds nothing of stands at nothing.
export type End = {
  size: number;
  tail: string;
  digest: string;
  of: number;
  last: string;
  by: string;
};

export const NOTHING: End = { size: 0, tail: "", digest: "", of: 0, last: "", by: "" };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A stretch of a file and the byte it ends before: a transcript's as its text, and a file beside one's, which may be an image, as base64. digest: of every byte of the file before that one, as the machine that sent the piece read them.
export type Piece = { upto: number; text: string; digest?: string };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a piece of a copy ends, and the digest of the copy up to there: what a machine compares its own file against, a piece at a time, without the copy's bytes.
export type Mark = { upto: number; digest: string };

const Stands = z.object({
  size: z.number(),
  tail: z.string(),
  digest: z.string(),
  of: z.number(),
  last: z.string(),
  by: z.string(),
});

const EndRow = Stands.nullable();
const Besides = z.array(Stands.extend({ file: z.string() }));

const PieceRows = z.array(z.object({ upto: z.number(), text: z.string() }));
const Marks = z.array(z.object({ upto: z.number(), digest: z.string() }));
const Held = z.object({ held: z.number() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What one reply carries of a transcript, so a long one crosses the network a page at a time.
const PAGE = 2 * 1024 * 1024;

// Half of what a Durable Object holds (https://developers.cloudflare.com/durable-objects/platform/limits/), counted in the files' own bytes, so the copies never fill it, base64 and all: an object that is full refuses every write, hex's records too.
const ROOM = 5 * 1024 * 1024 * 1024;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The marks one reply carries, so a copy of very many pieces is compared a page at a time.
export const MARKS = 8192;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A hub from before digests names none, and reads the copy by the rest.
const same = (one: End, other: Omit<End, "digest"> & { digest?: string }) =>
  one.size === other.size &&
  one.tail === other.tail &&
  (other.digest === undefined || one.digest === other.digest) &&
  one.of === other.of &&
  one.last === other.last &&
  one.by === other.by;

const ENDS = 'size, tail, digest, "of", last, by';

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

    for (const table of ["_transcripts", "_transcript_ends"]) {
      const has = this.db
        .query(`select 1 from pragma_table_info('${table}') where name = 'digest'`)
        .get();

      if (has === null) {
        this.db.run(`alter table ${table} add column digest text not null default ''`);
      }
    }

    this.db.run(
      "create index if not exists _transcript_marks on _transcripts (session, upto, digest)",
    );
    this.made = true;
  };

  end(session: string): End {
    this.tables();

    return (
      EndRow.parse(
        this.db.query(`select ${ENDS} from _transcript_ends where session = ?`).get(session),
      ) ?? NOTHING
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Lands only where the sender read the copy to stand, so one sent twice, or by a machine another has sent to the copy since, changes nothing. No pieces only says whose file the copy is and how long that file is. over: the copy keeps this many of its bytes, which end one of its pieces, and goes on from these pieces instead of what it held past them, for a file changed in place (true: none of them). Answers where the copy stands now.
  append(
    session: string,
    after: Omit<End, "digest"> & { digest?: string },
    pieces: Piece[],
    to: Pick<End, "tail" | "of" | "last" | "by"> & { digest?: string },
    over: boolean | number = false,
  ): End {
    return this.quiet(() => {
      const end = this.end(session);
      const from = over === true ? 0 : over === false ? end.size : over;

      if (!same(end, after) || !this.endsPiece(session, from, end)) {
        return end;
      }

      const size = pieces.at(-1)?.upto ?? from;

      const { held } = Held.parse(
        this.db.query("select coalesce(sum(size), 0) as held from _transcript_ends").get(),
      );

      if (held - end.size + size > ROOM) {
        throw new Error(
          `hex's store keeps ${ROOM} bytes of transcripts at most, and holds ${held}: closing threads frees it`,
        );
      }

      this.db.query("delete from _transcripts where session = ? and upto > ?").run(session, from);

      const insert = this.db.query(
        "insert into _transcripts (session, upto, text, digest) values (?, ?, ?, ?)",
      );

      for (const { upto, text, digest = "" } of pieces) {
        insert.run(session, upto, text, digest);
      }

      const now = {
        ...to,
        size,
        tail: size === 0 ? NOTHING.tail : to.tail,
        digest: size === 0 ? NOTHING.digest : (to.digest ?? ""),
      };

      this.db
        .query(
          'insert into _transcript_ends (session, size, tail, digest, "of", last, by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7) on conflict (session) do update set size = ?2, tail = ?3, digest = ?4, "of" = ?5, last = ?6, by = ?7',
        )
        .run(session, now.size, now.tail, now.digest, now.of, now.last, now.by);

      return now;
    });
  }

  private readonly endsPiece = (session: string, at: number, end: End) =>
    at === 0 ||
    at === end.size ||
    (at < end.size &&
      this.db
        .query("select 1 from _transcripts where session = ? and upto = ?")
        .get(session, at) !== null);

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

  marks(session: string, from: number): Mark[] {
    this.tables();

    return Marks.parse(
      this.db
        .query(
          `select upto, digest from _transcripts where session = ? and upto > ? order by upto limit ${MARKS}`,
        )
        .all(session, from),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The files beside a session's transcript that the store holds a copy of, each with where its copy stands.
  besides(session: string) {
    this.tables();

    return Besides.parse(
      this.db
        .query(
          `select substr(session, ${SESSION + 2}) as file, ${ENDS} from _transcript_ends where session > ?1 || '/' and session < ?1 || '0' order by session`,
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
