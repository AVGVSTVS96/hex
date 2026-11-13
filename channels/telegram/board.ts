import { readFileSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

import { CLAUDE, busy, ownership, running } from "@hex/hub";
import type { Session, Store, Thread } from "@hex/hub";
import { z } from "zod";

export const HTML = join(import.meta.dir, "board.html");

// Each of a widget's two states holds at most 1024 bytes, and a widget is at most 600px tall, which six rows and a "more" line under the counts fill: https://core.telegram.org/bots/widgets#limits
const ROOM = 1024;
const ROWS = 6;
const WORDS = 50;
const DAY = 24 * 60 * 60_000;
const CALM = 5000;

export type Line = { title: string; line: string; at: number; link?: string; count?: number };

export type Lines = { w: Line[]; n: Line[]; d: Line[] };

type Row =
  | [title: string, line: string, link: string, minutes: number]
  | [title: string, line: string, link: string, minutes: number, count: number];

export type State = { chat_data: string; public_data: string };

const plain = (text: string) =>
  text
    .replaceAll(/\*\*|__|`/gu, "")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replaceAll(/\s+/gu, " ")
    .trim();

const cut = (text: string) => {
  const one = plain(text);

  if (one.length <= WORDS) {
    return one;
  }

  const head = one.slice(0, WORDS);
  const space = head.lastIndexOf(" ");

  return `${(space > WORDS / 2 ? head.slice(0, space) : head.slice(0, WORDS - 1)).replace(/[\s,;:.–—-]+$/u, "")}…`;
};

function linkTo(thread: string, message: string | undefined) {
  const [chat = "", topic] = thread.split(":");

  return chat.startsWith("-100") && message !== undefined
    ? [chat.slice(4), topic, message.includes(":") ? undefined : message]
        .filter((part) => part !== undefined)
        .join("/")
    : undefined;
}

function newest(store: Store, thread: string) {
  const ids = store.messages
    .said(thread, 20)
    .map((row) => Number(row.meta?.message_id ?? /^(?:\w+:)?-?\d+:(\d+)$/u.exec(row.key)?.[1]))
    .filter((id) => id > 0);

  return ids.length > 0 ? String(Math.max(...ids)) : undefined;
}

const minute = (at: number) => Math.floor(at / 60_000);

const since = (session: Session) => session.updated ?? session.started;

const latestFirst = (rows: Line[]) => rows.toSorted((a, b) => b.at - a.at);

function proven(proof: string | undefined) {
  const url = /https:\/\/[^\s<>[\]()"'`]+/u.exec(proof ?? "")?.[0].replace(/[.,;:!?*_]+$/u, "");

  return url?.replace(/^https:\/\/t\.me\/c\//u, "");
}

export function lines(store: Store, sessions: Map<string, Session>, now = Date.now()): Lines {
  const all = store.threads.list({ open: true });

  const threads = new Map(
    all.filter(({ app }) => app === "telegram").map((thread) => [thread.thread, thread]),
  );

  const held = new Map(
    all.flatMap(({ app, thread, session }): [string, string][] =>
      session === undefined || session === "" ? [] : [[session, `${app}:${thread}`]],
    ),
  );

  const serving = new Map<string, Session[]>();

  for (const session of sessions.values()) {
    const owner = ownership(session, held, sessions).thread;
    const thread = owner?.startsWith("telegram:") === true ? owner.slice(9) : undefined;

    if (thread !== undefined && threads.has(thread)) {
      serving.set(thread, [...(serving.get(thread) ?? []), session]);
    }
  }

  const own = (thread: Thread) => sessions.get(thread.session ?? "");

  const working = [...threads.values()].flatMap((thread): Line[] => {
    const busyNow = (serving.get(thread.thread) ?? []).filter((session) => busy(session));
    const turning = thread.session !== undefined && store.turns.atWork(thread.session);

    if (busyNow.length === 0 && !turning) {
      return [];
    }

    const told = [own(thread), ...busyNow].find(
      (session) => session?.state === "working" && (session.detail ?? "") !== "",
    );

    const link = linkTo(thread.thread, newest(store, thread.thread));

    const [task] =
      told?.detail === undefined
        ? store.tasks.list({ owner: thread.thread, status: ["open"], words: false })
        : [];

    return [
      {
        title: thread.name,
        line: cut(told?.detail ?? task?.title ?? ""),
        at:
          busyNow.length > 0
            ? Math.min(...busyNow.map(since))
            : Date.parse(
                own(thread)?.began ?? store.messages.said(thread.thread, 1)[0]?.at ?? "",
              ) || now,
        ...(link !== undefined && { link }),
      },
    ];
  });

  const asked = new Map<string, { text: string; at: string; message: string }[]>();

  for (const question of store.questions.list({ app: "telegram", waiting: true })) {
    if (question.asker === undefined && threads.has(question.thread)) {
      asked.set(question.thread, [
        ...(asked.get(question.thread) ?? []),
        { text: question.text, at: question.at, message: String(question.message) },
      ]);
    }
  }

  const needs = [...threads.values()].flatMap((thread): Line[] => {
    const questions = (asked.get(thread.thread) ?? []).toSorted((a, b) => b.at.localeCompare(a.at));

    const session = own(thread);
    const blocked = session?.state === "blocked" && (session.needs ?? "") !== "";
    const [last] = questions;

    if (!blocked && last === undefined) {
      return [];
    }

    const link = linkTo(thread.thread, last?.message ?? newest(store, thread.thread));

    return [
      {
        title: thread.name,
        line: cut((blocked ? session.needs : last?.text) ?? ""),
        at: Math.max(blocked ? since(session) : 0, last === undefined ? 0 : Date.parse(last.at)),
        ...(link !== undefined && { link }),
        count: questions.length,
      },
    ];
  });

  const done = store.tasks.finished(new Date(now - DAY).toISOString()).flatMap((task): Line[] => {
    const thread = threads.get(task.owner);

    if (thread === undefined) {
      return [];
    }

    const link = proven(task.proof) ?? linkTo(thread.thread, newest(store, thread.thread));

    return [
      {
        title: thread.name,
        line: cut(task.title),
        at: Date.parse(task.closed ?? task.at),
        ...(link !== undefined && { link }),
      },
    ];
  });

  return { w: latestFirst(working), n: latestFirst(needs), d: latestFirst(done) };
}

/* The widget's two states, each within its 1024 bytes: working and waiting in the chat state, done
   in the shared one. `t` is when it was drawn, a row's time its minute after `b`, and its link the
   path after https://t.me/c/, starting at "/" for the chat most rows share (`c`). */
export function state(found: Lines, now = Date.now()): State {
  const chats = new Map<string, number>();

  for (const { link } of [...found.w, ...found.n, ...found.d]) {
    const chat = /^\d+(?=\/)/u.exec(link ?? "")?.[0];

    if (chat !== undefined) {
      chats.set(chat, (chats.get(chat) ?? 0) + 1);
    }
  }

  const c = [...chats].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const t = minute(now);

  const rows = (list: Line[], b: number): Row[] =>
    list.slice(0, ROWS).map(({ title, line, at, link = "", count }): Row => {
      const row: [string, string, string, number] = [
        title,
        line,
        c !== "" && link.startsWith(`${c}/`) ? link.slice(c.length) : link,
        minute(at) - b,
      ];

      return count !== undefined && count > 1 ? [...row, count] : row;
    });

  const fitted = (from: Partial<Lines>, k?: number[]) => {
    const b = Math.min(
      t,
      ...Object.values(from).flatMap((list) => list.map(({ at }) => minute(at))),
    );

    const lists = Object.fromEntries(
      Object.entries(from).map(([name, list]) => [name, rows(list, b)]),
    );

    const text = () => JSON.stringify({ t, b, c, ...(k !== undefined && { k }), ...lists });

    while (Buffer.byteLength(text()) > ROOM) {
      let longest: Row[] = [];

      for (const list of Object.values(lists)) {
        longest = list.length > longest.length ? list : longest;
      }

      longest.pop();
    }

    return text();
  };

  return {
    chat_data: fitted({ w: found.w, n: found.n }, [found.w.length, found.n.length, found.d.length]),
    public_data: fitted({ d: found.d }),
  };
}

const KeptFile = z.union([z.object({ message: z.number() }), z.object({ off: z.literal(true) })]);

type Kept = z.infer<typeof KeptFile>;

export type Paper = {
  send: (state: State) => Promise<number>;
  edit: (message: number, state: State) => Promise<"shown" | "gone">;
  remove: (message: number) => Promise<void>;
};

const content = ({ chat_data, public_data }: State) =>
  `${chat_data.replace(/^\{"t":\d+,/u, "{")}${public_data.replace(/^\{"t":\d+,/u, "{")}`;

/* The owner's board: one widget in their DM that the hub keeps current itself, on every change to
   hex.db and to the session records Claude Code keeps, so no session spends a turn on it. An edit
   counts against the bot's sending limit, so changes close together go out as one:
   https://core.telegram.org/bots/widgets#changing-the-state */
export class Keeper {
  private readonly store: Store;
  private readonly file: string;
  private readonly paper: Paper;
  private readonly claude: string;
  private readonly stops: (() => void)[] = [];
  private shown = "";
  private wrote = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(store: Store, file: string, paper: Paper, claude = CLAUDE) {
    this.store = store;
    this.file = file;
    this.paper = paper;
    this.claude = claude;
  }

  start(): Promise<void> {
    this.stops.push(
      this.store.watch(() => {
        this.soon();
      }),
    );

    for (const dir of ["sessions", "jobs"]) {
      const watcher = tryWatch(join(this.claude, dir), () => {
        this.soon();
      });

      if (watcher !== undefined) {
        this.stops.push(() => {
          watcher.close();
        });
      }
    }

    return this.turn(async () => {
      const kept = this.kept();

      await (kept === undefined ? this.post() : this.draw());
    });
  }

  again(): Promise<void> {
    return this.turn(async () => {
      const kept = this.kept();

      if (kept !== undefined && "message" in kept) {
        await this.paper.remove(kept.message).catch(() => null);
      }

      await this.post();
    });
  }

  stop() {
    clearTimeout(this.pending);

    for (const stop of this.stops.splice(0)) {
      stop();
    }
  }

  private soon() {
    if (this.pending !== undefined) {
      return;
    }

    this.pending = setTimeout(
      () => {
        this.pending = undefined;
        void this.turn(() => this.draw());
      },
      Math.max(1000, this.wrote + CALM - Date.now()),
    );
  }

  private now() {
    return state(lines(this.store, running(this.store, this.claude)));
  }

  private async post() {
    const now = this.now();
    const message = await this.paper.send(now);
    this.keep({ message });
    this.drew(now);
  }

  private async draw() {
    const kept = this.kept();

    if (kept === undefined || !("message" in kept)) {
      return;
    }

    const now = this.now();

    if (content(now) === this.shown) {
      return;
    }

    if ((await this.paper.edit(kept.message, now)) === "gone") {
      this.keep({ off: true });

      return;
    }

    this.drew(now);
  }

  private drew(now: State) {
    this.shown = content(now);
    this.wrote = Date.now();
  }

  private turn(change: () => Promise<void>): Promise<void> {
    const after = async (before: Promise<void>) => {
      await before;

      try {
        await change();
      } catch (error) {
        process.stderr.write(`telegram hub: couldn't keep the board current: ${String(error)}\n`);
      }
    };

    this.chain = after(this.chain);

    return this.chain;
  }

  private kept(): Kept | undefined {
    try {
      return KeptFile.parse(JSON.parse(readFileSync(this.file, "utf-8")));
    } catch {
      return undefined;
    }
  }

  private keep(kept: Kept) {
    writeFileSync(this.file, JSON.stringify(kept));
  }
}

function tryWatch(path: string, changed: () => void): FSWatcher | undefined {
  try {
    return watch(path, { recursive: true }, changed);
  } catch {
    return undefined;
  }
}
