import type { Database } from "bun:sqlite";

import { z } from "zod";

import { TextOrNull } from "./db.ts";
import type { Core, Write } from "./db.ts";

export type LaunchStamp = string;

export type Thread = {
  app: string;
  thread: string;
  name: string;
  open: boolean;
  session?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  launched?: LaunchStamp;
  fork?: string;
  link?: string;
};

export type Kept = Omit<Thread, "app" | "thread" | "open">;

const ThreadRows = z.array(
  z
    .object({
      app: z.string(),
      thread: z.string(),
      name: z.string(),
      open: z.number(),
      session: TextOrNull,
      cwd: TextOrNull,
      model: TextOrNull,
      effort: TextOrNull,
      launched: TextOrNull,
      fork: TextOrNull,
      link: TextOrNull,
    })
    .transform(
      ({
        app,
        thread,
        name,
        open: isOpen,
        session,
        cwd,
        model,
        effort,
        launched,
        fork,
        link,
      }): Thread => ({
        app,
        thread,
        name,
        ...(session !== null && { session }),
        ...(cwd !== null && { cwd }),
        ...(model !== null && { model }),
        ...(effort !== null && { effort }),
        ...(launched !== null && { launched }),
        ...(fork !== null && { fork }),
        ...(link !== null && { link }),
        open: isOpen !== 0,
      }),
    ),
);

export class Threads {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  keep(app: string, openNow: Record<string, Kept>) {
    this.write(() => {
      this.db
        .query(
          "update threads set open = 0 where app = ? and open = 1 and thread not in (select value from json_each(?))",
        )
        .run(app, JSON.stringify(Object.keys(openNow)));

      const keep = this.db.query(
        `insert into threads (app, thread, name, open, session, cwd, model, effort, launched, fork, link) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        on conflict (thread) do update set app = excluded.app, name = excluded.name, open = 1, session = excluded.session, cwd = excluded.cwd, model = excluded.model,
          effort = excluded.effort, launched = excluded.launched, fork = excluded.fork, link = coalesce(excluded.link, link)
        where (app, name, open, session, cwd, model, effort, launched, fork) is not (excluded.app, excluded.name, 1, excluded.session, excluded.cwd, excluded.model, excluded.effort, excluded.launched, excluded.fork)
          or coalesce(excluded.link, link) is not link`,
      );

      for (const [
        thread,
        { name, session, cwd, model, effort, launched, fork, link },
      ] of Object.entries(openNow)) {
        keep.run(
          app,
          thread,
          name,
          session ?? null,
          cwd ?? null,
          model ?? null,
          effort ?? null,
          launched ?? null,
          fork ?? null,
          link ?? null,
        );
      }
    });
  }

  list({ app, open: isOpen }: { app?: string; open?: boolean } = {}): Thread[] {
    return ThreadRows.parse(
      this.db
        .query(
          "select * from threads where (?1 is null or app = ?1) and (?2 is null or open = ?2) order by app, thread",
        )
        .all(app ?? null, isOpen === undefined ? null : Number(isOpen)),
    );
  }

  names(): Record<string, string> {
    const names = Object.fromEntries(this.list().map(({ thread, name }) => [thread, name]));
    Object.setPrototypeOf(names, null);

    return names;
  }

  ids(): Record<string, string> {
    const ids = Object.fromEntries(
      this.list().map(({ app, thread }) => [thread, `${app}:${thread}`]),
    );

    Object.setPrototypeOf(ids, null);

    return ids;
  }

  key(id: string): string {
    const split = id.indexOf(":");

    return split > 0 &&
      this.db.query("select 1 from threads where app = ? limit 1").get(id.slice(0, split)) !== null
      ? id.slice(split + 1)
      : id;
  }
}
