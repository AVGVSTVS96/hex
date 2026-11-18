import { z } from "zod";

import type { Core, Sql, Write } from "./db.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where the store's copy of a session's transcript ends: how many of the file's bytes it holds, and a digest of the last of them, by which a machine tells whether its own file goes on from there. A session the store holds nothing of ends at nothing.
export type End = { size: number; tail: string };

export const NOTHING: End = { size: 0, tail: "" };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A stretch of a transcript, as text, and the byte of the file it ends before.
export type Piece = { upto: number; text: string };

const EndRow = z.object({ size: z.number(), tail: z.string() }).nullable();
const PieceRows = z.array(z.object({ upto: z.number(), text: z.string() }));

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What one reply carries of a transcript, so a long one crosses the network a page at a time.
const PAGE = 2 * 1024 * 1024;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The transcripts of the sessions open threads are on, as Claude Code wrote them on the machine that ran each, so the session carries on from any machine that reaches the store. They are copies of files a machine holds, not records: their tables are the home's own, which no move or backup of the records carries, so the home makes them itself.
export class Transcripts {
  private readonly db: Sql;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
    db.run(
      "create table if not exists _transcripts (session text not null, upto integer not null, text text not null, primary key (session, upto))",
    );
    db.run(
      "create table if not exists _transcript_ends (session text primary key, size integer not null, tail text not null)",
    );
  }

  end(session: string): End {
    return (
      EndRow.parse(
        this.db.query("select size, tail from _transcript_ends where session = ?").get(session),
      ) ?? NOTHING
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Lands only on the end the sender read its pieces after, so one sent twice, or from a file that isn't the store's copy grown longer, changes nothing. Answers where the copy ends now.
  append(session: string, after: End, pieces: Piece[], tail: string): End {
    return this.write(() => {
      const end = this.end(session);
      const last = pieces.at(-1);

      if (last === undefined || end.size !== after.size || end.tail !== after.tail) {
        return end;
      }

      const insert = this.db.query(
        "insert into _transcripts (session, upto, text) values (?, ?, ?)",
      );

      for (const { upto, text } of pieces) {
        insert.run(session, upto, text);
      }

      this.db
        .query(
          "insert into _transcript_ends (session, size, tail) values (?, ?, ?) on conflict (session) do update set size = excluded.size, tail = excluded.tail",
        )
        .run(session, last.upto, tail);

      return { size: last.upto, tail };
    });
  }

  since(session: string, from: number): Piece[] {
    return PieceRows.parse(
      this.db
        .query(
          "select upto, text from _transcripts where session = ? and upto > ? and upto <= ? order by upto",
        )
        .all(session, from, from + PAGE),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Only a session an open thread is on, or forks from, is ever resumed, so the rest go: the machine that ran one keeps its file. Answers how many went.
  prune(): number {
    return this.write(() => {
      const unheld =
        "session not in (select session from threads where open = 1 and session is not null union select fork from threads where open = 1 and fork is not null)";

      this.db
        .query(
          `delete from _transcripts where session in (select session from _transcript_ends where ${unheld})`,
        )
        .run();

      return this.db.query(`delete from _transcript_ends where ${unheld}`).run().changes;
    });
  }
}
