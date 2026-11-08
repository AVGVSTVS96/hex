import { Database } from "bun:sqlite";
import { existsSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MessageId } from "../../hub/ledger.ts";
import { open } from "../../hub/store.ts";
import type { Item } from "./activity.ts";

export type Delegation = {
  id: string;
  task: string;
  parent: string;
  title: string;
  model?: string;
  status: string;
  since?: string;
  end?: string;
  result?: string;
  hex?: string;
  link?: string;
  latest: boolean;
  relay?: boolean;
};

const T3_HOME = join(homedir(), ".t3", "userdata");
const DATABASE = "statev2.sqlite";
const REFRESH = 500;
const ITEMS = 40;

type HandoffEnd = "done" | "failed" | "stopped";

// oxlint-disable-next-line anti-slop/no-known-value-widening -- callers look up any status T3 Code reports, and one that hasn't ended has no entry.
export const HANDED: Record<string, HandoffEnd> = {
  completed: "done",
  idle: "done",
  failed: "failed",
  interrupted: "stopped",
  cancelled: "stopped",
  rolled_back: "stopped",
};

const SHOWN = [
  "command_execution",
  "web_search",
  "file_change",
  "dynamic_tool",
  "reasoning",
  "assistant_message",
  "subagent",
  "error",
];

export class Links {
  private threads = new Map<string, { thread: string; title: string }>();
  private handed: Delegation[] = [];
  private ran = new Map<string, string>();
  private above = new Map<string, { parent: string; since: string }>();
  private starts = new Map<string, { parent: string; since: string; shown: boolean }>();
  private readonly items = new Map<string, Item[]>();
  private readonly titles = new Map<string, string | undefined>();
  private readonly state: string;
  private readonly changed: () => void;
  private readonly scheme: string;
  private readonly environment: string | undefined;
  private readonly db?: Database;
  private readonly watcher?: ReturnType<typeof watch>;
  private readonly unwatch?: () => void;
  private relays = "";
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(
    state: string,
    changed: () => void,
    t3 = T3_HOME,
    scheme = word(process.env.T3_APP_SCHEME) ?? "t3code",
  ) {
    this.state = state;
    this.changed = changed;
    this.scheme = scheme;
    const database = join(t3, DATABASE);

    if (!existsSync(database)) {
      return;
    }

    this.environment = word(readFile(join(t3, "environment-id"))?.trim());
    this.db = new Database(database, { readonly: true });
    this.watcher = watch(t3, (_, file) => {
      if (file?.startsWith(DATABASE) === true) {
        this.schedule();
      }
    });
    this.relays = JSON.stringify(open(state).relays());
    this.unwatch = open(state).watch(() => {
      const relays = JSON.stringify(open(state).relays());

      if (relays !== this.relays) {
        this.relays = relays;
        this.schedule();
      }
    });
    this.read();
  }

  close() {
    clearTimeout(this.pending);
    this.watcher?.close();
    this.unwatch?.();
    this.db?.close();
  }

  title(app: string, id: string): string | undefined {
    return app === "t3" ? word(this.threads.get(id)?.title) : undefined;
  }

  delegations(app: string, id: string) {
    return this.handed.filter((one) => one.parent === `${app}:${id}`);
  }

  delegated(app: string, id: string) {
    return (
      app === "t3" && this.owners(id).some((owner) => this.shows(owner, new Set([`t3:${id}`])))
    );
  }

  under(app: string, id: string) {
    if (app !== "t3" || !this.delegated(app, id)) {
      return;
    }

    const shows = (parent?: string) =>
      parent !== undefined && parent !== "" && this.shows(parent, new Set([`t3:${id}`]));

    const last = this.starts.get(this.threads.get(id)?.thread ?? "")?.parent;

    if (last !== undefined && last !== "" && this.owners(id).includes(last) && shows(last)) {
      return last;
    }

    let newest: Delegation | undefined;

    for (const one of this.handed) {
      if (
        one.hex === id &&
        (one.relay !== true || one.latest) &&
        shows(one.parent) &&
        (newest === undefined || (one.since ?? "") >= (newest.since ?? ""))
      ) {
        newest = one;
      }
    }

    return newest?.parent;
  }

  private owners(id: string) {
    return this.handed
      .filter((one) => one.hex === id && (one.relay !== true || one.latest))
      .map((one) => one.parent);
  }

  private shows(thread: string, passed: Set<string>): boolean {
    if (passed.has(thread)) {
      return false;
    }

    const owners = thread.startsWith("t3:") ? this.owners(thread.slice(3)) : [];

    return (
      owners.length === 0 || owners.some((owner) => this.shows(owner, new Set([...passed, thread])))
    );
  }

  runs(session: string) {
    return this.ran.has(session);
  }

  owner(session: string): { thread: string; handed: boolean } | undefined {
    const seen = new Set<string>();

    for (
      let thread = this.ran.get(session);
      thread !== undefined && thread !== "" && !seen.has(thread);
    ) {
      const one = this.starts.get(thread);
      const up = this.above.get(thread);

      if (one !== undefined && (up === undefined || one.since >= up.since)) {
        return { thread: one.parent, handed: seen.size === 0 && one.shown };
      }

      seen.add(thread);
      thread = up?.parent;
    }
  }

  name(id: string) {
    const one = this.handed.find((handoff) => handoff.task === id || handoff.id === id);

    if (one) {
      return one.title;
    }

    if (!this.titles.has(id)) {
      this.titles.set(
        id,
        word(
          this.db
            ?.query<{ title: string }, [string]>(
              "select title from orchestration_v2_projection_threads where thread_id = ?",
            )
            .get(id)?.title,
        ),
      );
    }

    return this.titles.get(id);
  }

  turns(thread: string) {
    let items = this.items.get(thread);

    if (!items) {
      items = (
        this.db
          ?.query<{ id: string; type: string; status: string; payload: string }, [string]>(
            `select turn_item_id id, type, status, payload_json payload from orchestration_v2_projection_turn_items
           where thread_id = ? and type in (${SHOWN.map((type) => `'${type}'`).join(", ")}) order by ordinal desc limit ${ITEMS}`,
          )
          .all(thread) ?? []
      ).map((item) => {
        const payload: unknown = JSON.parse(item.payload);

        return { ...item, payload };
      });
      this.items.set(thread, items);
    }

    return items;
  }

  private deep(thread: string) {
    return thread === "" || this.environment === undefined
      ? undefined
      : `${this.scheme}://threads/${this.environment}/${encodeURIComponent(thread)}`;
  }

  private schedule() {
    if (this.pending !== undefined) {
      return;
    }

    this.pending = setTimeout(() => {
      this.pending = undefined;

      if (this.read()) {
        this.changed();
      }
    }, REFRESH);
  }

  private read() {
    const db = this.db;

    if (db === undefined) {
      return false;
    }

    try {
      const rows = db
        .query<{ key: string; thread: string; title: string }, []>(
          `select json_extract(p.payload_json, '$.nativeThreadRef.nativeId') key, json_extract(p.payload_json, '$.appThreadId') thread, t.title
           from orchestration_v2_projection_provider_threads p
           join orchestration_v2_projection_threads t on t.thread_id = json_extract(p.payload_json, '$.appThreadId')
           where p.driver = 'acpRegistry' and t.deleted_at is null
           order by p.updated_at`,
        )
        .all();

      const threads = new Map(rows.map(({ key, thread, title }) => [key, { thread, title }]));
      const keys = new Map(rows.map(({ key, thread }) => [thread, key]));

      const subagents = db
        .query<
          Omit<Delegation, "hex" | "link" | "latest"> & { driver: string; latest: number | null },
          []
        >(
          `select s.child_thread_id id, s.subagent_id task, s.thread_id parent, s.driver, s.status, s.started_at since, s.completed_at "end",
             coalesce(json_extract(s.payload_json, '$.title'), 'a task') title, json_extract(s.payload_json, '$.model') model,
             substr(json_extract(s.payload_json, '$.result'), 1, 1000) result,
             s.started_at >= (select max(m.created_at) from orchestration_v2_projection_messages m
               where m.thread_id = s.thread_id and m.role = 'user' and json_extract(m.payload_json, '$.delegatedCompletion') is null) latest
           from orchestration_v2_projection_subagents s
           where s.origin = 'app_owned' and s.child_thread_id is not null
           order by s.started_at`,
        )
        .all();

      const handed = subagents
        .filter((row) => keys.has(row.parent))
        .map(({ driver, latest, parent, ...row }): Delegation => {
          const hex = driver === "acpRegistry" ? keys.get(row.id) : undefined;

          return omit({
            ...row,
            parent: `t3:${keys.get(parent)}`,
            result: handedBack(row.result),
            hex,
            link: this.deep(row.id),
            latest: latest === 1,
          });
        });

      const run = db.query<
        Omit<Delegation, "id" | "task" | "parent" | "hex" | "link" | "latest"> & { latest: number },
        [string]
      >(
        `select t.title, r.status, r.requested_at since, r.completed_at "end",
           r.ordinal = (select max(o.ordinal) from orchestration_v2_projection_runs o where o.thread_id = r.thread_id) latest,
           (select substr(json_extract(m.payload_json, '$.text'), 1, 1000) from orchestration_v2_projection_messages m
             where m.run_id = r.run_id and m.role = 'assistant' order by m.created_at desc limit 1) result
         from orchestration_v2_projection_runs r join orchestration_v2_projection_threads t on t.thread_id = r.thread_id
         where r.run_id = ? and t.deleted_at is null`,
      );

      const starts = new Map<string, { parent: string; since: string; shown: boolean }>();

      const start = (thread: string, parent: string, since = "", shown = false) => {
        if (since >= (starts.get(thread)?.since ?? "")) {
          starts.set(thread, { parent, since, shown });
        }
      };

      for (const one of handed) {
        start(one.id, one.parent, one.since, !HANDED[one.status]);
      }

      const relayed = open(this.state)
        .relays()
        .flatMap(({ from, thread, run: task, at }): Delegation[] => {
          const ran = run.get(task);
          const hex = keys.get(thread);

          if (!ran || from === `t3:${hex}`) {
            return [];
          }

          const behind = handed.findLast((one) => one.parent === from && one.id === thread);
          start(thread, from, at, !HANDED[(behind ?? ran).status]);

          return behind
            ? []
            : [
                omit({
                  ...ran,
                  id: thread,
                  task,
                  parent: from,
                  result: handedBack(ran.result),
                  hex,
                  link: this.deep(thread),
                  latest: ran.latest === 1,
                  relay: true,
                }),
              ];
        });

      handed.push(...relayed);

      const ran = new Map(
        db
          .query<{ session: string; thread: string }, []>(
            `select json_extract(payload_json, '$.nativeThreadRef.nativeId') session, json_extract(payload_json, '$.appThreadId') thread
             from orchestration_v2_projection_provider_threads where driver = 'claudeAgent' order by updated_at`,
          )
          .all()
          .map(({ session, thread }) => [session, thread]),
      );

      const above = new Map(
        subagents.map(({ id, parent, since }) => [id, { parent, since: since ?? "" }]),
      );

      const asked = this.items.size > 0;
      this.items.clear();
      this.titles.clear();
      const now = JSON.stringify([[...threads], handed, [...ran], [...above], [...starts]]);

      if (
        !asked &&
        now ===
          JSON.stringify([
            [...this.threads],
            this.handed,
            [...this.ran],
            [...this.above],
            [...this.starts],
          ])
      ) {
        return false;
      }

      this.threads = threads;
      this.handed = handed;
      this.ran = ran;
      this.above = above;
      this.starts = starts;

      return true;
    } catch (error) {
      process.stderr.write(`voice: links: couldn't read T3 Code's threads: ${String(error)}\n`);

      return false;
    }
  }
}

const T3_PLACEHOLDER_FOR_NO_RESULT = /^Child task ended with status \w+\.$/u;

function handedBack(result: string | null | undefined) {
  return result !== undefined &&
    result !== null &&
    result !== "" &&
    !T3_PLACEHOLDER_FOR_NO_RESULT.test(result)
    ? result
    : undefined;
}

type Absent<V> = [Extract<V, null | undefined>] extends [never] ? false : true;

type Present<T> = { [K in keyof T as Absent<T[K]> extends true ? never : K]: T[K] } & {
  [K in keyof T as Absent<T[K]> extends true ? K : never]?: Exclude<T[K], null | undefined>;
};

function omit<T extends object>(record: T) {
  // SAFETY: only entries holding null or undefined are dropped, which leaves each kept value of its type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries can't carry the record's keys.
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined),
  ) as Present<T>;
}

function word(value: string | null | undefined) {
  return value === undefined || value === null || value === "" ? undefined : value;
}

function readFile(path: string) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function linkAt(app: string, link: string | undefined, message?: MessageId) {
  if (link === undefined || link === "" || message === undefined) {
    return link;
  }

  if (app === "discord") {
    return `${link}/${message}`;
  }

  if (app === "telegram" && link.startsWith("https://t.me/c/")) {
    return `${link.replace(/\/1$/u, "")}/${message}`;
  }

  return link;
}
