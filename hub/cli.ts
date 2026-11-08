import { appendFileSync, mkdirSync, realpathSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { record, settingsOf } from "./claude.ts";
import { instant, line, place } from "./holds.ts";
import { checks } from "./ideas.ts";
import { history } from "./loaded.ts";
import { holds, keysOf, problems, verdict } from "./notes.ts";
import { busy, running, served, serving } from "./running.ts";
import type { Session } from "./running.ts";
import { asked, open as openStore, sent } from "./store.ts";
import type { Row, Status, Task, Thread } from "./store.ts";
import { entry, render, waiting } from "./tasks.ts";
import { zoneOf } from "./zone.ts";

const USAGE = `usage:
  hex deliver <from>[:<id>] --to <thread> [--user <name>] <words…>
  hex task new <message key> --title '<what the owner wants, in a few plain words>' [--quote <part of it>] [--owner <thread>] [--project <name>] [--done-when <outcome>] [--idea]
  hex task add <task> <message key> [--quote <part of it>]
  hex task quote <task> <message key> --quote <part of it>
  hex task done <task> --proof <link or fact>
  hex task drop <task> [--into <task it repeats>]
  hex task open <task>
  hex task edit <task> [--title '<title>'] [--owner <thread>] [--project <name>] [--done-when <outcome>]
  hex task agent <task> <agent or session id…>
  hex task <task> [--json]
  hex tasks [--owner <thread> | --all] [--status open,idea,done,dropped] [--json]
  hex hold <thread…> --why '<what the hold is for>' [--until 'YYYY-MM-DD HH:MM'] [--key <the owner's message>]
  hex hold end <hold> [<thread…>] --why '<what ends it>' [--key <the owner's message>]
  hex holds [--all] [--json]
  hex questions [--thread <thread> | --all] [--json]
  hex pins [--thread <thread> | --all] [--json]
  hex threads [--json]
  hex running [--json]
  hex message <key>
  hex profile [--all] [--json]
  hex log [<thread, by name or id, or a terminal session's id>] [--since <date>] [--last <n>] [--taken] [--room <characters>] [--json]
  hex recall <regex, in any case>
  hex watch`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string" },
    user: { type: "string" },
    title: { type: "string" },
    quote: { type: "string" },
    owner: { type: "string" },
    thread: { type: "string" },
    project: { type: "string" },
    "done-when": { type: "string" },
    idea: { type: "boolean" },
    proof: { type: "string" },
    into: { type: "string" },
    why: { type: "string" },
    until: { type: "string" },
    key: { type: "string" },
    status: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
    since: { type: "string" },
    last: { type: "string" },
    taken: { type: "boolean" },
    room: { type: "string" },
    "ignore-case": { type: "boolean", short: "i" },
  },
});

const [state = "", command = "", ...args] = positionals;

if (state === "" || command === "") {
  usage();
}

if (flags["ignore-case"] === true && command !== "recall") {
  console.error("hex: -i is only for recall");
  process.exit(2);
}

const taskWordsBeforeFlags = new Map([
  ["add", 3],
  ["quote", 3],
  ["new", 2],
  ["done", 2],
  ["drop", 2],
  ["open", 2],
  ["edit", 2],
  ["agent", Infinity],
]);

const wordsBeforeFlags = new Map([
  ["deliver", Infinity],
  ["message", 1],
  ["recall", 1],
  ["log", 1],
]);

const takes =
  command === "hold"
    ? Infinity
    : command === "task"
      ? (taskWordsBeforeFlags.get(args[0] ?? "") ?? 1)
      : (wordsBeforeFlags.get(command) ?? 0);

const unquotedValue = args[takes];

if (unquotedValue !== undefined) {
  console.error(`hex: ${stray(unquotedValue)}`);
  process.exit(1);
}

if (command === "watch") {
  await follow(join(state, "hex.bell"));
}

const store = openStore(state);

for (const flag of ["owner", "thread"] as const) {
  const given = flags[flag];

  if (filled(given)) {
    flags[flag] = store.key(given);
  }
}

const ownThread =
  flags.all === true || filled(process.env.HEX_MAIN) ? undefined : process.env.HEX_THREAD;

function filled(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

const STATUSES: Record<Status, true> = { idea: true, open: true, done: true, dropped: true };

function isStatus(word: string): word is Status {
  return Object.hasOwn(STATUSES, word);
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function lastFindings(task: Task) {
  return checks(state, task.id)
    .flatMap(({ at, news, finding }) => (filled(finding) ? [{ at, news, finding }] : []))
    .slice(-5)
    .map(
      ({ at, news, finding }) =>
        `  checked ${at.slice(0, 10)}${news === true ? ", news" : ""}: ${finding}`,
    );
}

function show(tasks: Task[], full = true) {
  if (flags.json === true) {
    console.log(
      JSON.stringify(
        withThread(tasks, (task) => task.owner),
        null,
        1,
      ),
    );

    return;
  }

  const names = store.names();

  console.log(
    tasks
      .map((task) =>
        full ? [render(task, names), ...lastFindings(task)].join("\n") : entry(task, names),
      )
      .join(full ? "\n\n" : "\n") || "no tasks",
  );
}

async function recall(pattern: string) {
  const memo = Bun.spawn([join(dirname(import.meta.dir), "vendor", "memo"), "recall", pattern], {
    stdout: "pipe",
    stderr: "inherit",
  });

  let kept = 0;
  let keyed = 0;
  let notes = 0;

  for (const recalled of (await new Response(memo.stdout).text()).split("\n")) {
    console.log(recalled);

    if (!/^#\d+ /u.test(recalled)) {
      continue;
    }

    notes++;
    const v = verdict(recalled, store);

    if (keysOf(recalled).length === 0) {
      continue;
    }

    keyed++;

    if (holds(v)) {
      kept++;
    } else {
      console.log(
        problems(v, false)
          .map((why) => `    ✗ ${why}`)
          .join("\n"),
      );
    }

    for (const said of v.keys) {
      console.log(
        said.body
          .split("\n")
          .map((words) => `    ${words}`)
          .join("\n"),
      );
    }
  }

  if (notes > 0) {
    console.log(`${notes} notes: ${keyed} name a message, ${kept} quote it as written.`);
  }

  process.exitCode = await memo.exited;
}

function withThread<T>(rows: T[], key: (row: T) => string) {
  const ids = store.ids();

  return rows.map((row) => {
    const threadId = ids[key(row)];

    return { ...row, ...(filled(threadId) && { threadId }) };
  });
}

function follow(bell: string): Promise<never> {
  mkdirSync(dirname(bell), { recursive: true });
  appendFileSync(bell, "");
  let size = -1;
  let timer: Timer | undefined;

  const check = () => {
    timer = undefined;
    const now = statSync(bell).size;

    if (now === size) {
      return;
    }

    size = now;
    process.stdout.write(`${new Date().toISOString()}\n`, (error) => {
      if (error) {
        process.exit("code" in error && error.code === "EPIPE" ? 0 : 1);
      }
    });
    // Bun's fs.watch can drop a change right after the last one: https://github.com/oven-sh/bun/issues/45954
    timer = setTimeout(check, 50);
  };

  return new Promise(() => {
    watch(bell, () => {
      timer ??= setTimeout(check, 50);
    });
    check();
  });
}

function stray(word: string) {
  return `"${word}" isn't a flag's value: quote every value that has spaces, like --title 'Fix the login page'`;
}

function named(given: string) {
  const key = store.key(given);
  const threads = store.threads();
  const keyed = threads.find(({ thread }) => thread === key);

  if (keyed) {
    return [keyed];
  }

  const wanted = given.trim().toLowerCase();
  const all = threads.filter(({ name }) => name.toLowerCase() === wanted);

  return all.length > 0 ? all : threads.filter(({ thread }) => thread === key.toLowerCase());
}

function threadsOf(given: string) {
  const threads = named(given).map(({ thread }) => thread);

  if (threads.length > 0) {
    return threads;
  }

  if (store.said(given, 1).length > 0) {
    return [given];
  }

  throw new Error(`no thread named "${given}"`);
}

function recipient(to: string): string {
  const all = named(to);
  const matches = all.some(({ open }) => open) ? all.filter(({ open }) => open) : all;

  if (matches.length > 1) {
    throw new Error(
      `more than one thread is named "${to}", so send to one by its id: ${matches.map(({ app, thread }) => `${app}:${thread}`).join(", ")}`,
    );
  }

  const thread = matches[0] ?? workingFor(to);

  if (!thread.open) {
    console.error(`hex: the thread ${thread.thread} is closed, so this waits until it opens again`);
  }

  return thread.thread;
}

function workingFor(given: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f-]*)?$/iu.test(given)) {
    throw new Error(`no thread is "${given}" (hex threads lists them)`);
  }

  const to = given.toLowerCase();
  const threads = store.threads();

  const held = new Map(
    threads
      .toSorted((a, b) => Number(a.open) - Number(b.open))
      .flatMap((thread): [string, Thread][] =>
        filled(thread.session) ? [[thread.session, thread]] : [],
      ),
  );

  const live = running(store);
  const nameOf = (id: string) => live.get(id)?.name;

  const labelled = (id: string) => {
    const name = nameOf(id);

    return filled(name) ? `${id} (${name})` : id;
  };

  const matches = [...new Set([...held.keys(), ...live.keys()])]
    .filter((id) => id.startsWith(to))
    .toSorted();

  if (matches.length > 1) {
    throw new Error(
      `${given} starts more than one session's id: ${matches.map(labelled).join(", ")}`,
    );
  }

  const [id] = matches;

  if (!filled(id)) {
    throw new Error(
      `no thread or running session is ${given} (hex threads and hex running list them)`,
    );
  }

  const job = live.get(id)?.job;
  const short = live.has(id) && !filled(job) && record(id.slice(0, 8)).sessionId === id;

  const bound =
    filled(job) || short
      ? settingsOf({ sessionId: id, pid: 0, ...(job !== undefined && { id: job }) })?.env
      : undefined;

  const boundStore = bound?.HEX_STORE;

  const thread =
    held.get(id) ??
    (filled(boundStore) && real(boundStore) === real(state)
      ? threads.find((each) => each.thread === bound?.HEX_THREAD)
      : undefined);

  if (thread) {
    return thread;
  }

  const name = nameOf(id);

  throw new Error(
    `${labelled(id)} is a session no thread holds, so it would never take this message${filled(name) ? `: message it with Claude Code's SendMessage to "${name}"` : ""}`,
  );
}

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function log(said: Row[]) {
  const room = flags.room === undefined ? Infinity : Number(flags.room);

  if (
    !(room === Infinity || (Number.isInteger(room) && room > 0)) ||
    (flags.room !== undefined && flags.json === true)
  ) {
    usage();
  }

  const rows = said.map((row) =>
    row.from === "t3" && row.author === "owner" ? { ...row, body: asked(row.body) } : row,
  );

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        withThread(rows, (row) => row.to),
        null,
        1,
      ),
    );

    return;
  }

  const zone = zoneOf(dirname(state)) ?? Temporal.Now.timeZoneId();
  const names = store.names();

  const entries = rows.map((row) => {
    const at = Temporal.Instant.from(row.at)
      .toZonedDateTimeISO(zone)
      .toPlainDateTime()
      .toString()
      .slice(0, 16)
      .replace("T", " ");

    const { failed, message_id: messageId, user } = row.meta ?? {};
    const failure = filled(failed) ? ` · failed: ${failed}` : "";
    const name = names[row.to];
    const thread = filled(name) ? `${name} (${row.to})` : row.to;
    const id = filled(messageId) ? ` · message ${messageId}` : "";

    const who =
      filled(user) && (row.author === "prompt" || row.author === "other")
        ? `${row.author} (${user})`
        : row.author;

    return `## ${who} · ${row.from} · ${thread} · ${at} · [${row.key}]${id}${failure}\n\n${row.body}\n`;
  });

  let start = entries.length;

  for (let size = 0; start > 0; start--) {
    size += (entries[start - 1] ?? "").length + 1;

    if (size > room) {
      break;
    }
  }

  const newest = entries.at(-1);

  for (const shown of start < entries.length || newest === undefined
    ? entries.slice(start)
    : [end(newest, room)]) {
    console.log(shown);
  }
}

function end(newest: string, room: number) {
  const head = newest.slice(0, newest.indexOf("\n\n") + 2);
  let from = Math.max(head.length, newest.length - Math.max(0, room - head.length - 2));

  if (/[\uDC00-\uDFFF]/u.test(newest[from] ?? "")) {
    from++;
  }

  return `${head}…${newest.slice(from)}`;
}

function runTask(verb: string, id: string | undefined, key: string | undefined, more: string[]) {
  const thread = process.env.HEX_THREAD;

  switch (verb) {
    case "new": {
      const said = filled(id) ? store.message(id) : null;

      if (!filled(id) || !said) {
        throw new Error(
          filled(id) ? `no message ${id}` : "name the message the task comes from by its key",
        );
      }

      show([
        store.createTask({
          title: flags.title ?? "",
          message: id,
          owner: flags.owner ?? thread ?? said.to,
          status: flags.idea === true ? "idea" : "open",
          ...(flags.quote !== undefined && { quote: flags.quote }),
          ...(flags.project !== undefined && { project: flags.project }),
          ...(flags["done-when"] !== undefined && { doneWhen: flags["done-when"] }),
        }),
      ]);

      return;
    }

    case "add": {
      if (!filled(id) || !filled(key)) {
        usage();
      }

      show([store.addWords(id, key, flags.quote)]);

      return;
    }

    case "quote": {
      if (!filled(id) || !filled(key) || !filled(flags.quote)) {
        usage();
      }

      show([store.requote(id, key, flags.quote)]);

      return;
    }

    case "done": {
      if (!filled(id) || !filled(flags.proof)) {
        throw new Error("a task is done with --proof: a link or a fact that shows it");
      }

      show([
        store.editTask(id, {
          status: "done",
          proof: flags.proof,
          ...(thread !== undefined && { doneIn: thread }),
        }),
      ]);

      return;
    }

    case "drop": {
      if (!filled(id)) {
        usage();
      }

      show([
        filled(flags.into)
          ? store.mergeTasks(flags.into, id)
          : store.editTask(id, { status: "dropped" }),
      ]);

      return;
    }

    case "open": {
      if (!filled(id)) {
        usage();
      }

      show([store.editTask(id, { status: "open" })]);

      return;
    }

    case "edit": {
      if (!filled(id)) {
        usage();
      }

      show([
        store.editTask(id, {
          ...(flags.title !== undefined && { title: flags.title }),
          ...(flags.owner !== undefined && { owner: flags.owner }),
          ...(flags.project !== undefined && { project: flags.project }),
          ...(flags["done-when"] !== undefined && { doneWhen: flags["done-when"] }),
        }),
      ]);

      return;
    }

    case "agent": {
      if (!filled(id) || more.length === 0) {
        usage();
      }

      show([store.addAgents(id, more, thread)]);

      return;
    }

    default: {
      const found = filled(verb) ? store.task(verb) : null;

      if (!found) {
        throw new Error(filled(verb) ? `no task ${verb}` : USAGE);
      }

      show([found]);
    }
  }
}

function holdable(names: string[], among?: string[]) {
  return names.map((given) => {
    const all = named(given);

    const matches = among
      ? all.filter(({ thread }) => among.includes(thread))
      : all.some(({ open }) => open)
        ? all.filter(({ open }) => open)
        : all;

    const [first] = matches;

    if (first !== undefined && matches.length === 1) {
      return first.thread;
    }

    if (matches.length > 0) {
      throw new Error(
        `more than one thread is named "${given}", so name one by its id: ${matches.map(({ app, thread }) => `${app}:${thread}`).join(", ")}`,
      );
    }

    throw new Error(
      all.length > 0
        ? `that hold doesn't hold "${given}"`
        : `no thread is "${given}" (hex threads lists them; quote every value that has spaces)`,
    );
  });
}

function heldBySession(threads: Thread[]) {
  return new Map(
    threads.flatMap(({ app, thread, session }): [string, string][] =>
      filled(session) ? [[session, `${app}:${thread}`]] : [],
    ),
  );
}

function working() {
  const threads = store.threads({ open: true });
  const held = heldBySession(threads);

  const sessions = running(store);

  const busyNow = [...sessions.values()]
    .filter((session) => busy(session) || session.state === "working")
    .flatMap((session) => serving(session, held, sessions) ?? []);

  return new Set([
    ...busyNow.map((thread) => store.key(thread)),
    ...threads
      .filter(({ session }) => filled(session) && store.atWork(session))
      .map(({ thread }) => thread),
  ]);
}

function hold(words: string[]) {
  const zone = zoneOf(dirname(state));

  if (filled(flags.key) && !store.message(flags.key)) {
    throw new Error(`no message ${flags.key}`);
  }

  if (words[0] === "end") {
    const [, id, ...threads] = words;

    if (!filled(id) || !filled(flags.why)) {
      usage();
    }

    const existing = store.holdOf(id);

    if (!existing) {
      throw new Error(`no hold ${id}`);
    }

    const freed = store.unhold(
      id,
      `${flags.why}${filled(flags.key) ? ` [${flags.key}]` : ""}`,
      threads.length > 0
        ? holdable(
            threads,
            existing.threads.map(({ thread }) => thread),
          )
        : undefined,
    );

    const names = store.names();
    console.log(
      freed.length > 0
        ? `${id} freed ${freed.map((thread) => names[thread] ?? thread).join(", ")}; hex wakes each that worked while held, a couple at a time`
        : `${id} held none of them any more`,
    );

    return;
  }

  if (words.length === 0 || !filled(flags.why)) {
    usage();
  }

  const by = store.key([process.env.HEX_THREAD, served()].find(filled) ?? "terminal");

  const placed = place(
    store,
    {
      threads: holdable(words),
      by,
      why: flags.why,
      ...(flags.key !== undefined && { message: flags.key }),
      ...(filled(flags.until) && { until: instant(flags.until, zone) }),
    },
    { working: working(), ...(zone !== undefined && { zone }) },
  );

  console.log(line(placed, store, zone));
}

try {
  switch (command) {
    case "hold": {
      hold(args);
      break;
    }

    case "holds": {
      const listed = store.holds({ all: flags.all === true });

      if (flags.json === true) {
        console.log(JSON.stringify(listed, null, 1));
      } else {
        console.log(
          listed.map((each) => line(each, store, zoneOf(dirname(state)))).join("\n") ||
            "nothing on hold",
        );
      }

      break;
    }

    case "deliver": {
      const [given, ...words] = args;
      const from = given?.split(":")[0];

      if (!filled(given) || !filled(from) || !filled(flags.to) || words.length === 0) {
        usage();
      }

      const key = from === given ? `${from}:${crypto.randomUUID()}` : given;
      store.deliver({
        key,
        to: recipient(flags.to),
        from,
        author: "prompt",
        body: words.join(" "),
        meta: { user: flags.user ?? from },
      });
      break;
    }

    case "task": {
      runTask(args[0] ?? "", args[1], args[2], args.slice(2));
      break;
    }

    case "tasks": {
      const owner = flags.owner ?? ownThread;

      show(
        store.tasks({
          status: flags.status?.split(",").filter(isStatus) ?? ["open"],
          ...(owner !== undefined && { owner }),
        }),
        false,
      );
      break;
    }

    case "questions": {
      const thread = flags.thread ?? ownThread;

      const questions = store.questions({
        waiting: true,
        ...(thread !== undefined && { thread }),
      });

      if (flags.json === true) {
        console.log(
          JSON.stringify(
            questions.map((question) => ({
              ...question,
              threadId: `${question.app}:${question.thread}`,
            })),
            null,
            1,
          ),
        );
      } else {
        console.log(
          questions.map((question) => waiting(question, store.names())).join("\n") ||
            "no questions waiting",
        );
      }

      break;
    }

    case "pins": {
      const thread = flags.thread ?? ownThread;
      const pins = store.pins(thread === undefined ? {} : { thread });
      const names = store.names();

      if (flags.json === true) {
        console.log(
          JSON.stringify(
            pins.map((pin) => ({ ...pin, threadId: `${pin.app}:${pin.thread}` })),
            null,
            1,
          ),
        );
      } else {
        console.log(
          pins
            .map(
              (pin) =>
                `${pin.app} · ${names[pin.thread] ?? pin.thread} · message ${pin.message} · ${(pin.note === "" ? pin.text : pin.note).trim().split("\n")[0]}`,
            )
            .join("\n") || "no pins",
        );
      }

      break;
    }

    case "threads": {
      const threads = store.threads();

      if (flags.json === true) {
        console.log(
          JSON.stringify(
            threads.map((thread) => ({ id: `${thread.app}:${thread.thread}`, ...thread })),
            null,
            1,
          ),
        );
      } else {
        console.log(
          threads
            .map(
              ({ app, thread, name, open }) => `${app} ${thread} ${name}${open ? "" : " (closed)"}`,
            )
            .join("\n"),
        );
      }

      break;
    }

    case "profile": {
      const everyVersion = flags.all === true;
      const versions = everyVersion ? store.profiles() : store.profiles().slice(0, 1);

      if (flags.json === true) {
        console.log(JSON.stringify(everyVersion ? versions : (versions[0] ?? null), null, 1));
      } else {
        console.log(
          versions
            .map(({ at, body }) => (everyVersion ? `--- ${at}\n${body}\n` : body))
            .join("\n") || "no profile yet",
        );
      }

      break;
    }

    case "running": {
      const threads = store.threads({ open: true });
      const held = heldBySession(threads);
      const names = new Map(threads.map(({ app, thread, name }) => [`${app}:${thread}`, name]));
      const home = realpathSync(dirname(state));
      const sessions = running(store);
      const updates = history(resolve(import.meta.dir, ".."));

      const behind = (session: Session, thread?: string) => {
        const runsHex = filled(thread) || filled(session.helper);
        const from = runsHex ? updates.on(session.started) : undefined;

        if (!filled(from)) {
          return;
        }

        const changed = updates.changed(from);

        return changed.length > 0 ? { from, changed } : undefined;
      };

      const rows = [...sessions.values()].map((session) => {
        const thread = serving(session, held, sessions);

        return { ...session, thread, behind: behind(session, thread) };
      });

      if (flags.json === true) {
        console.log(JSON.stringify(rows, null, 1));
      } else {
        console.log(
          rows
            .map(({ id, status, name, cwd, thread, state: doing, detail, needs, behind: old }) => {
              const now = doing === "blocked" && filled(needs) ? needs : detail;

              return `${status} ${id.slice(0, 8)} ${name ?? ""}${filled(cwd) && cwd !== home ? ` in ${cwd}` : ""}${filled(thread) ? ` · ${names.get(thread) ?? thread} (${thread})` : ""}${old ? ` · started on an older hex (${old.from.slice(0, 7)}), ${old.changed.join(", ")} changed since` : ""}${filled(doing) ? ` · ${doing}${filled(now) ? `: ${now.replaceAll(/\s+/gu, " ")}` : ""}` : ""}`;
            })
            .join("\n") || "nothing running",
        );
      }

      break;
    }

    case "message": {
      const [key] = args;
      const said = filled(key) ? store.latest(key) : null;

      if (!said) {
        throw new Error(`no message ${key ?? ""}`);
      }

      console.log(
        flags.json === true
          ? JSON.stringify(said, null, 1)
          : said.from === "t3" && said.author === "owner"
            ? sent(said.body).join("\n\n")
            : said.body,
      );
      const under = said.meta?.edit ?? (said.key === key ? undefined : said.key);

      if (filled(under) && flags.json !== true) {
        console.error(`(edited: these are the words of ${under}, the key to quote them under)`);
      }

      break;
    }

    case "log": {
      const zone = zoneOf(dirname(state)) ?? Temporal.Now.timeZoneId();

      const since = filled(flags.since)
        ? new Date(
            Temporal.PlainDateTime.from(flags.since).toZonedDateTime(zone).epochMilliseconds,
          ).toISOString()
        : "";

      const [given] = args;

      if (args.length > 0 && !filled(given)) {
        console.error("hex log: name the thread, by its name or id");
        process.exit(2);
      }

      const last = filled(flags.last) ? Number(flags.last) : -1;
      const threads = filled(given) ? threadsOf(given) : [];

      const rows =
        threads.length > 0
          ? threads
              .flatMap((thread) => store.said(thread, last))
              .toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
              .slice(last < 0 ? 0 : -last)
          : store.since(since);

      log(
        rows.filter((row) => row.at > since && (flags.taken !== true || row.taken !== undefined)),
      );
      break;
    }

    case "recall": {
      const [pattern] = args;

      if (!filled(pattern)) {
        usage();
      }

      await recall(pattern);
      break;
    }

    default: {
      usage();
    }
  }
} catch (error) {
  console.error(`hex: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
