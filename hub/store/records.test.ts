import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { File } from "../store.ts";
import type { NewRow } from "../store.ts";
import type { Core } from "./db.ts";
import type { Domains } from "./domains.ts";
import { objectStorage } from "./fake.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { recordsIn } from "./storage.ts";
import type { Storage } from "./storage.ts";

type Records = Domains &
  Core & {
    atMigration: (version: number) => void;
    reopened: () => Records;
  };

function inFile(dir: string): Records {
  const file = new File(dir);

  return Object.assign(file, {
    atMigration: (version: number) => file.db.run(`pragma user_version = ${String(version)}`),
    reopened: () => {
      file.db.close();

      return inFile(dir);
    },
  });
}

function emptyObject(): Storage {
  const storage = objectStorage();
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");

  return storage;
}

function inObject(dir: string, storage = emptyObject()): Records {
  const { core, records } = recordsIn(storage, dir);
  const made = records();

  if (made === undefined) {
    throw new Error("the object took no records");
  }

  return {
    ...made,
    ...core,
    atMigration: (version) => {
      storage.sql.exec("update _home set version = ?", version);
    },
    reopened: () => inObject(dir, storage),
  };
}

const inEachHome = test.each([
  { home: "a file", open: inFile },
  { home: "an object", open: inObject },
]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "records-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const message = {
  key: "telegram:-100:42",
  to: "-100:7",
  from: "telegram",
  body: "remind me to water the plants",
  author: "owner",
  meta: { user: "victor" },
} satisfies NewRow;

function running(store: Records, text: string) {
  return () => {
    store.db.run(text);
  };
}

function quoted(task: { words: { text: string }[] }) {
  return task.words.map((words) => words.text);
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function anyString(): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.any(String);
}

inEachHome(
  "a message is kept once, word for word, and a resend under its key changes nothing ($home)",
  ({ open }) => {
    const store = open(dir);
    expect(store.messages.deliver(message)).toBe(true);
    expect(store.messages.deliver({ ...message, body: "something else" })).toBe(false);
    const kept = store.messages.get(message.key);
    expect(kept).toMatchObject({ ...message });
    expect(kept?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    expect(kept?.taken).toBeUndefined();
  },
);

inEachHome(
  "a key has to start with its sender, so the keys hex makes stay its own ($home)",
  ({ open }) => {
    const store = open(dir);
    expect(() =>
      store.messages.deliver({ ...message, key: "schedule:heartbeat@2026-10-18T21:45Z" }),
    ).toThrow();
    expect(() => store.messages.deliver({ ...message, key: "42" })).toThrow();
    expect(store.messages.untaken()).toEqual([]);
  },
);

inEachHome(
  "a message reads as its newest edit, made in any topic of its chat, even when only the edit was kept ($home)",
  ({ open }) => {
    const store = open(dir);

    const sent = {
      key: "telegram:-100:42",
      to: "-100:7",
      from: "telegram",
      author: "hex",
      body: "Deploy at 5",
    } satisfies NewRow;

    store.messages.deliver(sent);
    expect(store.messages.latest(sent.key)?.body).toBe("Deploy at 5");
    store.messages.deliver({
      ...sent,
      key: "telegram:edit-1",
      body: "Deploy at 6",
      meta: { edited: "true", message_id: "42" },
    });
    store.messages.deliver({
      ...sent,
      key: "telegram:edit-2",
      body: "Deploy at 7",
      meta: { edited: "true", message_id: "42" },
    });
    store.messages.deliver({
      ...sent,
      key: "telegram:edit-3",
      to: "-200:3",
      body: "another chat",
      meta: { edited: "true", message_id: "42" },
    });
    store.messages.deliver({
      ...sent,
      key: "discord:edit-4",
      from: "discord",
      body: "another app",
      meta: { edited: "true", message_id: "42" },
    });
    expect(store.messages.latest(sent.key)?.body).toBe("Deploy at 7");
    store.messages.deliver({
      ...sent,
      key: "telegram:edit-5",
      to: "-100:9",
      body: "Deploy at 8, edited from another topic",
      meta: { edited: "true", message_id: "42" },
    });
    expect(store.messages.latest(sent.key)).toMatchObject({
      key: sent.key,
      to: "-100:7",
      body: "Deploy at 8, edited from another topic",
    });
    expect(store.messages.latest("telegram:-100:43")).toBeNull();
    store.messages.deliver({
      key: "buzz:e2",
      to: "thread",
      from: "buzz",
      author: "owner",
      body: "tagged on edit",
      meta: { edited: "true", message_id: "e1" },
    });
    expect(store.messages.latest("buzz:e1")?.body).toBe("tagged on edit");
  },
);

inEachHome(
  "a message a topic's session sent into another chat reads as its newest edit, kept by its id with its chat ($home)",
  ({ open }) => {
    const store = open(dir);

    const sent = {
      key: "telegram:2000:55",
      to: "-100:7",
      from: "telegram",
      author: "hex",
      body: "Tiles",
    } satisfies NewRow;

    store.messages.deliver(sent);
    store.messages.deliver({
      ...sent,
      key: "telegram:edit-6",
      body: "Bigger tiles",
      meta: { edited: "true", message_id: "telegram:2000:55" },
    });
    store.messages.deliver({
      ...sent,
      key: "telegram:edit-7",
      body: "the group's own message 55",
      meta: { edited: "true", message_id: "55" },
    });
    expect(store.messages.latest(sent.key)?.body).toBe("Bigger tiles");
  },
);

inEachHome(
  "the first session to take a message has it, and it leaves what waits ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(message);
    store.messages.deliver({ ...message, key: "telegram:-100:43", body: "and some chips" });
    store.messages.deliver({ ...message, key: "telegram:-100:44", to: "-100:9" });
    expect(store.messages.take(message.key, "session-a")).toBe(true);
    expect(store.messages.take(message.key, "session-b")).toBe(false);
    expect(store.messages.take("telegram:-100:99", "session-a")).toBe(false);
    expect(store.messages.get(message.key)?.taken?.by).toBe("session-a");
    expect(store.messages.untaken("-100:7").map((row) => row.body)).toEqual(["and some chips"]);
    expect(store.messages.untaken().map((row) => row.key)).toEqual([
      "telegram:-100:43",
      "telegram:-100:44",
    ]);
  },
);

inEachHome(
  "some threads' untaken messages, and a mark that moves only when a thread's messages do ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(message);
    store.messages.deliver({ ...message, key: "telegram:-100:43", to: "-100:8" });
    store.messages.deliver({ ...message, key: "telegram:-100:44", to: "-100:9" });
    expect(store.messages.untaken(["-100:9", "-100:7"]).map((row) => row.key)).toEqual([
      message.key,
      "telegram:-100:44",
    ]);
    const mark = store.messages.mark("-100:7");
    store.messages.take("telegram:-100:43", "session-a");
    expect(store.messages.mark("-100:7")).toBe(mark);
    store.messages.take(message.key, "session-a");
    const taken = store.messages.mark("-100:7");
    expect(taken).not.toBe(mark);
    store.messages.deliver({ ...message, key: "telegram:-100:45" });
    const kept = store.messages.mark("-100:7");
    expect(kept).not.toBe(taken);
    expect(
      store.messages.past([
        [{ ...message, key: "telegram:-100:46" }, "2020-01-01T00:00:00.000Z", "session-a"],
      ]),
    ).toEqual(["telegram:-100:46"]);
    expect(store.messages.mark("-100:7")).not.toBe(kept);
  },
);

inEachHome(
  "a schedule's slot fires once, and its next slot fires whether or not the last was taken ($home)",
  ({ open }) => {
    const store = open(dir);
    const minute = Date.UTC(2026, 9, 18, 21, 45) / 60_000;
    expect(store.scheduler.fire("heartbeat", minute, "general", "[heartbeat] Hourly check")).toBe(
      true,
    );
    expect(store.scheduler.fire("heartbeat", minute, "general", "[heartbeat] Hourly check")).toBe(
      false,
    );
    expect(
      store.scheduler.fire("heartbeat", minute + 60, "general", "[heartbeat] Hourly check"),
    ).toBe(true);
    expect(store.scheduler.fire("call", minute, "general", "[call] Ring if needed", true)).toBe(
      true,
    );
    expect(store.messages.get("schedule:heartbeat@2026-10-18T21:45Z")).toMatchObject({
      to: "general",
      from: "schedule",
      meta: { user: "schedule", schedule: "heartbeat" },
    });
    expect(store.messages.get("schedule:call@2026-10-18T21:45Z")?.meta?.late).toBe("true");
  },
);

inEachHome("the scheduler keeps the last minute it checked ($home)", ({ open }) => {
  const store = open(dir);
  expect(store.scheduler.checked()).toBeUndefined();
  store.scheduler.check(100);
  store.scheduler.check(101);
  expect(store.reopened().scheduler.checked()).toBe(101);
});

const ask = {
  ...message,
  key: "telegram:-100:50",
  body: "Fix the login page. Also the logo looks blurry on retina.",
};

inEachHome("a task from before titles gets its first words as its title ($home)", ({ open }) => {
  const store = open(dir);
  store.messages.deliver({ ...ask, body: "Fix the login page.\nIt 500s on submit." });
  store.tasks.create({ title: "x", message: ask.key, owner: "-100:7" });
  store.db.run("update tasks set title = null");
  store.db.run("drop index said; drop table profiles");
  store.db.run("alter table messages drop column author");
  store.db.run("drop table seen");
  store.db.run(
    "drop table pins; create table shown (session text primary key, digest text not null); drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))",
  );
  store.db.run("drop table turns; drop table relays");
  store.atMigration(10);
  expect(store.reopened().tasks.get("t-1")?.title).toBe("Fix the login page. It 500s on submit.");
});

inEachHome(
  "a task has a clean title of its own, and its words still come from the message ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);

    const task = store.tasks.create({
      title: "  Sharpen the logo on retina ",
      message: ask.key,
      owner: "-100:7",
    });

    expect(task).toMatchObject({
      title: "Sharpen the logo on retina",
      words: [{ text: ask.body }],
    });
    expect(() => store.tasks.create({ title: " ", message: ask.key, owner: "-100:7" })).toThrow(
      "needs a title",
    );
    expect(store.tasks.edit(task.id, { title: "Make the logo crisp" }).title).toBe(
      "Make the logo crisp",
    );
    expect(() => store.tasks.edit(task.id, { title: " \n" })).toThrow("can't be empty");
    expect(store.tasks.edit(task.id, { title: "Make the logo\n  crisp " }).title).toBe(
      "Make the logo crisp",
    );
    expect(store.tasks.edit(task.id, { status: "done", proof: "abc123" }).title).toBe(
      "Make the logo crisp",
    );
    expect(store.tasks.edit(task.id, { status: "open" }).proof).toBeUndefined();
  },
);

inEachHome(
  "a task holds the owner's words as they sent them, quoted whole or in part, and never retyped ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    const whole = store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
    expect(whole).toMatchObject({
      id: "t-1",
      owner: "-100:7",
      status: "open",
      words: [{ message: ask.key, text: ask.body, who: "owner" }],
    });
    expect(
      store.tasks.create({
        title: "Fix it",
        message: ask.key,
        quote: "the logo looks blurry on retina",
        owner: "-100:7",
      }).words[0]?.text,
    ).toBe("the logo looks blurry on retina");
    expect(() =>
      store.tasks.create({
        title: "Fix it",
        message: ask.key,
        quote: "the logo is blurry",
        owner: "-100:7",
      }),
    ).toThrow("isn't in telegram:-100:50 as written");
    expect(() =>
      store.tasks.create({ title: "Fix it", message: "telegram:-100:404", owner: "-100:7" }),
    ).toThrow("no message");
    expect(
      running(
        store,
        "insert into words (task, message, text) values (1, 'telegram:-100:50', 'fix it all')",
      ),
    ).toThrow("character for character");
    expect(running(store, "update words set text = 'Fix it' where task = 1")).toThrow(
      "only ever cut down",
    );
    expect(running(store, "update messages set body = 'Fix it'")).toThrow("keeps its words");
    expect(() =>
      store.tasks.create({ title: "Fix it", message: ask.key, quote: "", owner: "-100:7" }),
    ).toThrow("needs words");
    store.db.run(
      "insert or replace into messages (key, \"to\", \"from\", author, body, at) values ('telegram:-100:50', '-100:7', 'telegram', 'owner', 'Fix it', '2026-10-19T00:00:00.000Z')",
    );
    expect(store.messages.get(ask.key)?.body).toBe(ask.body);
    expect(
      running(
        store,
        "insert or replace into words (rowid, task, message, text) values (1, 1, 'telegram:-100:50', 'Fix the login page.')",
      ),
    ).toThrow("never rewritten");
    expect(store.tasks.list().map((task) => task.id)).toEqual(["t-2", "t-1"]);
    expect(store.tasks.list({ owner: "-100:7", status: ["open"], words: false })).toEqual(
      store.tasks
        .list({ owner: "-100:7", status: ["open"] })
        .map(({ words: _words, ...task }) => task),
    );
    expect(store.tasks.get("t-1")?.words[0]?.text).toBe(ask.body);
  },
);

inEachHome(
  "a task can be cut down to the words that ask, still quoted as written ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
    expect(
      store.tasks.requote("t-1", ask.key, "Fix the login page.").words.map((words) => words.text),
    ).toEqual(["Fix the login page."]);
    expect(() => store.tasks.requote("t-1", ask.key, "fix it all")).toThrow(
      "holds no whole message",
    );
    expect(
      store.tasks.requote("t-1", ask.key, "Fix the login page.").words.map((words) => words.text),
    ).toEqual(["Fix the login page."]);
    expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
      "Fix the login page.",
    ]);
    expect(running(store, "update words set text = 'Fix it all' where task = 1")).toThrow(
      "only ever cut down",
    );
    expect(running(store, "delete from words")).toThrow("never taken away");
  },
);

inEachHome(
  "cutting a whole message down keeps the other asks quoted from it ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
    store.tasks.addWords("t-1", ask.key, "the logo looks blurry on retina");
    store.tasks.requote("t-1", ask.key, "Fix the login page.");
    expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
      "Fix the login page.",
      "the logo looks blurry on retina",
    ]);
  },
);

inEachHome(
  "a task already holding the ask folds its whole copy of the message into it ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
    store.tasks.addWords("t-1", ask.key, "Fix the login page.");
    expect(
      store.tasks.requote("t-1", ask.key, "Fix the login page.").words.map((words) => words.text),
    ).toEqual(["Fix the login page."]);
    expect(
      store.tasks.requote("t-1", ask.key, "Fix the login page.").words.map((words) => words.text),
    ).toEqual(["Fix the login page."]);
    expect(running(store, "update words set rowid = 99 where task = 1")).toThrow(
      "only ever cut down",
    );
  },
);

inEachHome(
  "cutting takes the whole message and leaves quotes picked on purpose alone ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
    store.messages.deliver({ ...ask, key: "telegram:-100:51", body: "Also the docs." });
    store.tasks.addWords("t-1", "telegram:-100:51");
    store.tasks.addWords("t-1", ask.key, "Fix the login page.");
    store.tasks.requote("t-1", ask.key, "Fix the login page.");
    expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
      "Fix the login page.",
      "Also the docs.",
    ]);
    store.tasks.addWords("t-1", ask.key, "the logo looks blurry on retina");
    expect(() => store.tasks.requote("t-1", ask.key, "blurry")).toThrow("holds no whole message");
    expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
      "Fix the login page.",
      "Also the docs.",
      "the logo looks blurry on retina",
    ]);
    expect(running(store, "delete from words where text = 'Also the docs.'")).toThrow(
      "never taken away",
    );
  },
);

inEachHome(
  "a task from a T3 Code prompt holds what was asked, not T3's instructions around it ($home)",
  ({ open }) => {
    const store = open(dir);

    const body =
      "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n<runtime_info>opus</runtime_info>";

    const prompt = (key: string, text: string) =>
      store.messages.deliver({
        key,
        to: "thread-1",
        from: "t3",
        author: "owner",
        body: text,
        meta: { ts: "2026-10-20T00:00:00.000Z" },
      });

    prompt("t3:1", body);
    expect(
      store.tasks.create({ title: "Fix it", message: "t3:1", owner: "thread-1" }).words[0]?.text,
    ).toBe("ship it");
    expect(() => store.tasks.addWords("t-1", "t3:1", body)).toThrow("isn't in");
    expect(quoted(store.tasks.addWords("t-1", "t3:1"))).toEqual(["ship it"]);
    expect(quoted(store.tasks.requote("t-1", "t3:1", "ship"))).toEqual(["ship"]);
    expect(quoted(store.tasks.requote("t-1", "t3:1", "ship"))).toEqual(["ship"]);
    prompt("t3:2", `${body}\n\n[image: /inbox/1.png]`);
    expect(
      quoted(store.tasks.create({ title: "Fix it", message: "t3:2", owner: "thread-1" })),
    ).toEqual(["ship it", "[image: /inbox/1.png]"]);
    expect(quoted(store.tasks.requote("t-2", "t3:2", "ship"))).toEqual([
      "ship",
      "[image: /inbox/1.png]",
    ]);
    store.tasks.addWords("t-2", "t3:2");
    expect(store.tasks.get("t-2")?.words.map((words) => words.text)).toEqual([
      "ship",
      "[image: /inbox/1.png]",
    ]);
    prompt(
      "t3:5",
      "<t3_code_instructions>\nx\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n[image: /inbox/2.png]",
    );
    expect(
      quoted(store.tasks.create({ title: "Fix it", message: "t3:5", owner: "thread-1" })),
    ).toEqual(["ship it", "[image: /inbox/2.png]"]);
    prompt(
      "t3:4",
      "<user_request>\nmake the header say\n<title>Hello</title>\n</user_request>\n\n<runtime_info>opus</runtime_info>",
    );
    expect(
      store.tasks.create({ title: "Fix it", message: "t3:4", owner: "thread-1" }).words[0]?.text,
    ).toBe("make the header say\n<title>Hello</title>");
    prompt("t3:3", "and the docs\n\n<runtime_info>opus</runtime_info>");
    expect(
      store.tasks.create({ title: "Fix it", message: "t3:3", owner: "thread-1" }).words[0]?.text,
    ).toBe("and the docs");
    store.messages.deliver({
      ...ask,
      key: "telegram:-100:51",
      body: "paste: <user_request>x</user_request>",
    });
    expect(
      store.tasks.create({ title: "Fix it", message: "telegram:-100:51", owner: "-100:7" }).words[0]
        ?.text,
    ).toBe("paste: <user_request>x</user_request>");
  },
);

inEachHome(
  "follow-ups are added after what was said first, and a repeat changes nothing ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    store.messages.deliver({
      ...message,
      key: "telegram:-100:51",
      body: "and make it work on mobile",
    });

    const task = store.tasks.create({
      title: "Fix it",
      message: ask.key,
      quote: "Fix the login page.",
      owner: "-100:7",
    });

    store.tasks.addWords(task.id, "telegram:-100:51");
    store.tasks.addWords(task.id, "telegram:-100:51");
    expect(store.tasks.get(task.id)?.words.map((words) => words.text)).toEqual([
      "Fix the login page.",
      "and make it work on mobile",
    ]);
  },
);

inEachHome("done needs a proof, and the states are the four a task has ($home)", ({ open }) => {
  const store = open(dir);
  store.messages.deliver(ask);

  const { id } = store.tasks.create({
    title: "Fix it",
    message: ask.key,
    owner: "-100:7",
    status: "idea",
  });

  expect(() => store.tasks.edit(id, { status: "done" })).toThrow();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion anti-slop/require-safety-comment-for-type-assertion -- a status outside the four, to show the store refuses it
  expect(() => store.tasks.edit(id, { status: "finished" as never })).toThrow();
  store.tasks.edit(id, { project: "site", doneWhen: "it signs in" });
  expect(store.tasks.edit(id, { owner: "-100:9", project: undefined })).toMatchObject({
    owner: "-100:9",
    project: "site",
    doneWhen: "it signs in",
  });
  expect(store.tasks.edit(id, { status: "done", proof: "https://example.com/pr/1" })).toMatchObject(
    {
      status: "done",
      proof: "https://example.com/pr/1",
    },
  );
  expect(store.tasks.list({ status: ["open", "idea"] })).toEqual([]);
  expect(store.tasks.list({ status: ["done"] }).map((task) => task.id)).toEqual([id]);
});

inEachHome(
  "a task keeps when it was closed: set when it ends, kept through later edits, cleared if it opens again ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    const { id } = store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
    expect(store.tasks.get(id)).toMatchObject({ id, status: "open" });
    expect(store.tasks.get(id)?.closed).toBeUndefined();
    const { closed } = store.tasks.edit(id, { status: "done", proof: "https://example.com/pr/1" });
    expect(closed).toBeString();
    expect(store.tasks.edit(id, { proof: "https://example.com/pr/2" }).closed).toBe(closed);
    expect(store.tasks.edit(id, { status: "open" }).closed).toBeUndefined();

    const duplicate = store.tasks.create({
      title: "Fix it",
      message: ask.key,
      quote: "Fix the login page.",
      owner: "-100:7",
    });

    expect(store.tasks.merge(id, duplicate.id)).toMatchObject({ status: "open" });
    expect(store.tasks.get(duplicate.id)?.closed).toBeString();
  },
);

inEachHome(
  "a merge puts the duplicate's words after the task's own, drops it, and its follow-ups go where it went ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(ask);
    store.messages.deliver({
      ...message,
      key: "telegram:-100:60",
      to: "-100:9",
      body: "the login page is broken",
    });
    store.messages.deliver({
      ...message,
      key: "telegram:-100:61",
      to: "-100:9",
      body: "still broken btw",
    });

    const kept = store.tasks.create({
      title: "Fix it",
      message: ask.key,
      quote: "Fix the login page.",
      owner: "-100:7",
    });

    const duplicate = store.tasks.create({
      title: "Fix it",
      message: "telegram:-100:60",
      owner: "-100:9",
    });

    const merged = store.tasks.merge(kept.id, duplicate.id);
    expect(merged.words.map((words) => words.text)).toEqual([
      "Fix the login page.",
      "the login page is broken",
    ]);
    expect(store.tasks.get(duplicate.id)).toMatchObject({ status: "dropped", mergedInto: kept.id });
    expect(store.tasks.addWords(duplicate.id, "telegram:-100:61").id).toBe(kept.id);
    expect(store.tasks.get(kept.id)?.words).toHaveLength(3);
    expect(() => store.tasks.edit(duplicate.id, { status: "open" })).toThrow();
    expect(() => store.tasks.merge(kept.id, duplicate.id)).toThrow("dropped");
    expect(() => store.tasks.merge(kept.id, kept.id)).toThrow("itself");
  },
);

inEachHome(
  "each app's threads.json comes into the records once, as that app's open threads ($home)",
  ({ open }) => {
    const store = open(dir);
    store.db.run(
      "drop table pins; create table shown (session text primary key, digest text not null); alter table seen drop column at; drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))",
    );
    store.db.run("insert into threads values ('telegram', '-100:9', 'Errands')");
    store.db.run("drop table turns; drop table relays");
    store.atMigration(16);
    mkdirSync(join(dir, "telegram"));
    writeFileSync(
      join(dir, "telegram", "threads.json"),
      JSON.stringify({
        "-100:7": { name: "Desk", session: "s-1", cwd: "/w", from: "s-0", launched: "abc" },
      }),
    );
    mkdirSync(join(dir, "discord"));
    writeFileSync(join(dir, "discord", "threads.json"), '{"broken');
    writeFileSync(join(dir, "threads.json"), JSON.stringify({ "7": { name: "Outside a hex" } }));
    expect(store.reopened().threads.list()).toEqual(
      [
        {
          app: "telegram",
          thread: "-100:7",
          name: "Desk",
          session: "s-1",
          cwd: "/w",
          launched: "abc",
          fork: "s-0",
          open: true,
        },
        { app: "telegram", thread: "-100:9", name: "Errands", open: false },
        { app: basename(dir), thread: "7", name: "Outside a hex", open: true },
      ].toSorted((a, b) => a.app.localeCompare(b.app) || a.thread.localeCompare(b.thread)),
    );
    expect(
      ["telegram/threads.json", "threads.json"].map((file) => existsSync(join(dir, file))),
    ).toEqual([false, false]);
    expect(readFileSync(join(dir, "telegram", "threads.json.moved-to-hex.db"), "utf-8")).toContain(
      "Desk",
    );
  },
);

inEachHome(
  "a session that ended loses what it was shown, and log/'s turns headed t become T3's ($home)",
  ({ open }) => {
    const store = open(dir);
    store.db.run(
      "create table files (name text primary key, body text not null); create table shown (session text primary key, digest text not null); alter table seen drop column at",
    );
    const shown = store.db.query("insert into seen (session, kind, record) values (?, ?, ?)");
    shown.run("ended", "tasks", "old");
    shown.run("live", "tasks", "now");
    shown.run("live", "rules", "{}");
    store.db
      .query('insert into messages (key, "to", "from", author, body, at) values (?, ?, ?, ?, ?, ?)')
      .run("t:past:abc:0", "abc", "t", "owner", "Quick test from T3", "2026-10-08T10:16:00.000Z");
    store.db.run("drop table turns; drop table relays");
    store.atMigration(20);
    const after = store.reopened();
    expect([
      after.seen.get("ended", "tasks"),
      after.seen.get("live", "tasks"),
      after.seen.get("live", "rules"),
    ]).toEqual(["", "now", "{}"]);
    expect(after.messages.get("t3:past:abc:0")).toMatchObject({ from: "t3", author: "owner" });
    expect(after.messages.get("t:past:abc:0")).toBeNull();
  },
);

const SENT_WITH_A_QUESTION = [
  [10, "hex", "The new m?", "", "02:40:20"],
  [11, "hex", "(file: logo.png)", "A", "02:40:22"],
  [12, "hex", "(file: logo.png)", "B", "02:40:23"],
  [13, "owner", "yes", "", "02:41:00"],
  [14, "hex", "(file: logo.png)", "C", "02:41:05"],
  [20, "hex", "Ship it?", "D", "03:00:00"],
  [30, "hex", "Rename it?", "", "04:00:00"],
  [31, "hex", "(file: late.png)", "E", "04:05:00"],
] as const;

inEachHome(
  "an older question gets the file messages hex sent right with it, and nothing it didn't ($home)",
  ({ open }) => {
    const store = open(dir);
    const thread = "-100:9";

    const sent = store.db.query(
      'insert into messages (key, "to", "from", author, body, meta, at) values (?, ?, ?, ?, ?, ?, ?)',
    );

    for (const [id, author, body, file, time] of SENT_WITH_A_QUESTION) {
      const meta = file === "" ? {} : { file: "logo.png", attachment_file_id: file };
      sent.run(
        `telegram:-100:${id}`,
        thread,
        "telegram",
        author,
        body,
        JSON.stringify(meta),
        `2026-11-12T${time}.000Z`,
      );
    }

    for (const [id, , text] of SENT_WITH_A_QUESTION.filter(([n]) => n % 10 === 0)) {
      store.questions.ask({ app: "telegram", thread, message: id, text, options: ["Yes", "No"] });
    }

    store.atMigration(
      appendOnlyMigrations.findIndex(({ name }) => name === "attachOldQuestionsTheirFiles"),
    );

    const after = store.reopened();

    expect([10, 20, 30].map((id) => after.questions.get("telegram", thread, id)?.attached)).toEqual(
      [["11", "12"], ["20"], undefined],
    );
  },
);

inEachHome(
  "each app's relays.jsonl comes into the records once, the newest run per pair of threads ($home)",
  ({ open }) => {
    mkdirSync(join(dir, "discord"));

    const lines = [
      { at: "2026-10-21T10:00:00.000Z", from: "fix", thread: "thread-prims", run: "run-1" },
      { at: "2026-10-21T10:05:00.000Z", from: "fix", thread: "thread-codex", run: "run-2" },
      { at: "2026-10-21T10:10:00.000Z", from: "fix", thread: "thread-prims", run: "run-3" },
    ];

    writeFileSync(
      join(dir, "discord", "relays.jsonl"),
      [...lines.map((line) => JSON.stringify(line)), "not json", ""].join("\n"),
    );
    expect(open(dir).relays.list()).toEqual([
      { from: "discord:fix", thread: "thread-codex", run: "run-2", at: "2026-10-21T10:05:00.000Z" },
      { from: "discord:fix", thread: "thread-prims", run: "run-3", at: "2026-10-21T10:10:00.000Z" },
    ]);
    expect(existsSync(join(dir, "discord", "relays.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "discord", "relays.jsonl.moved-to-hex.db"))).toBe(true);
  },
);

inEachHome(
  "a session's turns: one begins, ends, and the next begins again, an end from before its begin is old news, and one not heard from in 30 days goes ($home)",
  ({ open }) => {
    const store = open(dir);
    store.turns.turned("s-1", true);
    expect(store.turns.get("s-1")).toEqual({ began: anyString(), handled: anyString() });
    store.turns.turned("s-1", false);
    const { began = "", ended = "" } = store.turns.get("s-1");
    expect(began).not.toBe("");
    expect(ended >= began).toBe(true);
    store.turns.turned("s-1", true, "2026-10-21T10:00:00.000Z");
    store.turns.turned("s-1", false, "2026-10-21T09:59:59.000Z");
    expect(store.turns.get("s-1")).toEqual({
      began: "2026-10-21T10:00:00.000Z",
      handled: anyString(),
    });
    store.db.run(
      "update turns set began = '2026-01-01T00:00:00.000Z', ended = '2026-01-01T00:00:01.000Z'",
    );
    store.turns.turned("s-2", true);
    expect(store.turns.get("s-1")).toEqual({});
    expect(store.turns.get("s-2")).toEqual({ began: anyString(), handled: anyString() });
  },
);

inEachHome(
  "a turn begun with the message it took lands with it or not at all, and a turn recorded as answered is handled in the same write ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver(message);
    expect(store.turns.took(message.key, "s-1", true, "2026-10-21T10:00:00.000Z")).toBe(true);
    expect(store.turns.get("s-1").began).toBe("2026-10-21T10:00:00.000Z");
    expect(store.turns.took(message.key, "s-2", true)).toBe(false);
    expect(store.turns.get("s-2")).toEqual({});
    store.turns.recorded("s-1", false, "2026-10-21T10:01:00.000Z", "handled");
    expect(store.turns.get("s-1")).toEqual({
      began: "2026-10-21T10:00:00.000Z",
      ended: "2026-10-21T10:01:00.000Z",
      handled: "2026-10-21T10:01:00.000Z",
    });
  },
);

inEachHome(
  "a thread's sessions cut short mid-turn give back what they took since last handled, never hex's own words or what was typed in them; a turn that ended, answered, failed or handled by the hub, gives nothing back ($home)",
  async ({ open }) => {
    const store = open(dir);

    const give = (key: string, from = "telegram", author: "owner" | "hex" = "owner") =>
      store.messages.deliver({ key: `${from}:${key}`, to: "7", from, author, body: key, meta: {} });

    give("answered");
    store.turns.turned("s-1", true, "2026-10-21T10:00:00.000Z");
    store.messages.take("telegram:answered", "s-1");
    store.turns.handled("s-1");
    await Bun.sleep(2);
    give("open");
    store.turns.turned("s-1", true);
    store.messages.take("telegram:open", "s-1");
    give("reply", "telegram", "hex");
    store.messages.take("telegram:reply", "s-1");
    store.messages.deliver(
      {
        key: "terminal:typed",
        to: "7",
        from: "terminal",
        author: "owner",
        body: "typed",
        meta: {},
      },
      "s-1",
    );
    give("unsaved");
    store.turns.turned("s-2", true, "2026-10-21T10:00:00.000Z");
    store.messages.take("telegram:unsaved", "s-2");
    expect(store.turns.midTurn("7")).toBe(true);
    expect(store.turns.cut("7").given.toSorted()).toEqual(["telegram:open", "telegram:unsaved"]);
    expect(store.messages.untaken("7").map((row) => row.key)).toEqual([
      "telegram:open",
      "telegram:unsaved",
    ]);
    expect(store.turns.get("s-1").ended).toBeDefined();
    expect(store.turns.midTurn("7")).toBe(false);
    expect(store.turns.cut("7").given).toEqual([]);
    give("failed");
    store.turns.turned("s-3", true, "2026-10-21T10:00:00.000Z");
    store.messages.take("telegram:failed", "s-3");
    store.turns.turned("s-3", false);
    give("stopped");
    store.turns.turned("s-4", true, "2026-10-21T10:00:00.000Z");
    store.messages.take("telegram:stopped", "s-4");
    store.turns.handled("s-4");
    give("old");
    store.messages.take("telegram:old", "s-0");
    expect(store.turns.cut("7").given).toEqual([]);
  },
);

inEachHome(
  "a session cut short after turns that ended with its background agents working gives back only what it took since the last of them, however often it is cut: nothing while it waits or in a turn an agent's report began, and a turn's own messages ($home)",
  async ({ open }) => {
    const store = open(dir);

    const turn = async (key: string) => {
      store.messages.deliver({
        key: `telegram:${key}`,
        to: "7",
        from: "telegram",
        author: "owner",
        body: key,
        meta: {},
      });
      store.turns.turned("s-1", true);
      store.messages.take(`telegram:${key}`, "s-1");
      await Bun.sleep(2);
    };

    const waitOnAgents = async () => {
      store.turns.turned("s-1", false);
      store.turns.waitsOnAgents("s-1");
      await Bun.sleep(2);
    };

    await turn("start the agents");
    await waitOnAgents();
    await turn("a question meanwhile");
    await waitOnAgents();
    expect(store.turns.midTurn("7")).toBe(true);
    expect(store.turns.cut("7", "s-1")).toEqual({ given: [], waited: true });
    expect(store.turns.midTurn("7")).toBe(false);
    expect(store.turns.cut("7", "s-1")).toEqual({ given: [], waited: false });

    await turn("the hub's line");

    expect(store.turns.cut("7", "s-1")).toEqual({
      given: ["telegram:the hub's line"],
      waited: false,
    });

    await turn("the hub's line");
    store.turns.handled("s-1");
    await turn("start more agents");
    await waitOnAgents();
    store.turns.turned("s-1", true);
    expect(store.turns.cut("7", "s-1")).toEqual({ given: [], waited: true });

    await turn("and more");
    await waitOnAgents();
    await turn("cut off in this turn");

    expect(store.turns.cut("7", "s-1")).toEqual({
      given: ["telegram:cut off in this turn"],
      waited: true,
    });

    await turn("cut off in this turn");

    expect(store.turns.cut("7", "s-1")).toEqual({
      given: ["telegram:cut off in this turn"],
      waited: false,
    });

    expect(store.messages.untaken("7").map((row) => row.key)).toEqual([
      "telegram:cut off in this turn",
    ]);
  },
);

inEachHome(
  "a session that only posted in a thread, as General does opening a topic, isn't one of its sessions: cutting the thread leaves that session's turn and what it took alone ($home)",
  ({ open }) => {
    const store = open(dir);
    store.messages.deliver({
      key: "telegram:ask",
      to: "general",
      from: "telegram",
      author: "owner",
      body: "make a topic",
      meta: {},
    });
    store.turns.turned("general-1", true, "2026-10-21T10:00:00.000Z");
    store.messages.take("telegram:ask", "general-1");
    store.messages.deliver(
      {
        key: "telegram:opened",
        to: "topic",
        from: "telegram",
        author: "hex",
        body: "this topic is its home",
        meta: {},
      },
      "general-1",
    );
    expect(store.turns.midTurn("topic")).toBe(false);
    expect(store.turns.cut("topic").given).toEqual([]);
    expect(store.messages.untaken("general")).toEqual([]);
    expect(store.turns.midTurn("general")).toBe(true);
  },
);

inEachHome(
  "a thread keeps its row after it closes, and takes a new name when renamed ($home)",
  ({ open }) => {
    const store = open(dir);
    store.threads.keep("telegram", {
      "-100:7": { name: "pricehub", session: "s-1", cwd: "/w" },
      "-100:8": { name: "website" },
    });
    store.threads.keep("telegram", {
      "-100:7": {
        name: "pricehub and stage",
        session: "s-2",
        model: "opus",
        link: "https://t.me/c/100/7",
      },
    });
    store.threads.keep("discord", { "1561": { name: "Repair" } });
    expect(store.threads.list()).toEqual([
      { app: "discord", thread: "1561", name: "Repair", open: true },
      {
        app: "telegram",
        thread: "-100:7",
        name: "pricehub and stage",
        session: "s-2",
        model: "opus",
        link: "https://t.me/c/100/7",
        open: true,
      },
      { app: "telegram", thread: "-100:8", name: "website", open: false },
    ]);
    expect(
      store.threads.list({ app: "telegram", open: true }).map((thread) => thread.thread),
    ).toEqual(["-100:7"]);
  },
);

inEachHome(
  "a thread's key names it in every app, and its id is <app>:<key> ($home)",
  ({ open }) => {
    const store = open(dir);
    store.threads.keep("discord", { "1561": { name: "Repair" }, "1562": { name: "Stage" } });
    store.threads.keep("telegram", { "-100:7": { name: "Shop" } });
    store.threads.keep("buzz", { "1561": { name: "Shop" }, abc: { name: "Buzz shop" } });
    expect(store.threads.list({ app: "buzz" }).map(({ thread }) => thread)).toEqual([
      "1561",
      "abc",
    ]);
    store.threads.keep("discord", { "1561": { name: "Repair" }, "1562": { name: "Stage" } });
    expect(store.threads.names()).toEqual({
      "1561": "Repair",
      "1562": "Stage",
      "-100:7": "Shop",
      abc: "Buzz shop",
    });
    expect(store.threads.ids()).toEqual({
      "1561": "discord:1561",
      "1562": "discord:1562",
      "-100:7": "telegram:-100:7",
      abc: "buzz:abc",
    });
    expect(
      ["discord:1561", "1561", "telegram:-100:7", "-100:7", "slack:1", "abc", "constructor"].map(
        (id) => store.threads.key(id),
      ),
    ).toEqual(["1561", "1561", "-100:7", "-100:7", "slack:1", "abc", "constructor"]);
    expect(["constructor" in store.threads.names(), "constructor" in store.threads.ids()]).toEqual([
      false,
      false,
    ]);
  },
);

inEachHome(
  "a key two apps had before keys were global keeps its open, then newest, row ($home)",
  ({ open }) => {
    const store = open(dir);
    store.db.run("drop index threads_key");
    store.atMigration(23);
    store.db.run(
      "insert into threads (app, thread, name, open) values ('buzz', 'k', 'old', 0), ('discord', 'k', 'live', 1), ('t3', 'k', 'closed too', 0), ('buzz', 'j', 'first', 0), ('t3', 'j', 'later', 0)",
    );
    expect(
      store
        .reopened()
        .threads.list()
        .map(({ app, thread }) => `${app}:${thread}`),
    ).toEqual(["discord:k", "t3:j"]);
  },
);

inEachHome(
  "what a session was shown is kept per kind until its context loses it, and a tasks record unchanged for 2 days goes, a rules one after a week, since a session's end leaves it behind and one still there just gets its whole list again ($home)",
  ({ open }) => {
    const store = open(dir);
    expect(store.seen.get("session-a", "tasks")).toBe("");
    store.seen.show("session-a", "tasks", "one");
    store.seen.show("session-a", "rules", "{}");
    store.seen.show("session-b", "tasks", "two");
    expect(store.seen.get("session-a", "tasks")).toBe("one");
    store.seen.unshow("session-a", "tasks");
    expect([
      store.seen.get("session-a", "tasks"),
      store.seen.get("session-a", "rules"),
      store.seen.get("session-b", "tasks"),
    ]).toEqual(["", "{}", "two"]);
    store.seen.show("session-c", "tasks", "three", daysFromNow(3));
    expect([
      store.seen.get("session-a", "rules"),
      store.seen.get("session-b", "tasks"),
      store.seen.get("session-c", "tasks"),
    ]).toEqual(["{}", "", "three"]);
    store.seen.show("session-a", "rules 2", "{}");
    store.seen.show("session-d", "rules", "{}", daysFromNow(8));
    expect([
      store.seen.get("session-a", "rules"),
      store.seen.get("session-a", "rules 2"),
      store.seen.get("session-d", "rules"),
    ]).toEqual(["", "", "{}"]);
  },
);

inEachHome(
  "a question keeps its first answer, a poll's vote replaces the one before, and taking one back says whether there was one ($home)",
  ({ open }) => {
    const store = open(dir);

    store.questions.ask({
      app: "telegram",
      thread: "-100:7",
      message: 41,
      text: "Deploy now?",
      options: ["Deploy", "Wait"],
    });
    expect(store.questions.answered("telegram", "-100:7", 41, "Wait", "telegram")).toBe(true);
    expect(store.questions.answered("telegram", "-100:7", 41, "Deploy", "app")).toBe(false);
    expect(store.questions.get("telegram", "-100:7", 41)?.answer).toMatchObject({
      label: "Wait",
      via: "telegram",
    });
    expect(store.questions.answered("telegram", "-100:7", 41, "Deploy", "telegram", true)).toBe(
      true,
    );
    expect(store.questions.get("telegram", "-100:7", 41)?.answer).toMatchObject({
      label: "Deploy",
    });
    expect(store.questions.reopened("telegram", "-100:7", 41)).toBe(true);
    expect(store.questions.reopened("telegram", "-100:7", 41)).toBe(false);
    expect(store.questions.answered("telegram", "-100:7", 99, "Wait", "telegram")).toBe(false);
  },
);

inEachHome(
  "an answer and the message that wakes its thread with it land together or not at all ($home)",
  ({ open }) => {
    const store = open(dir);
    store.questions.ask({
      app: "telegram",
      thread: "-100:7",
      message: 41,
      text: "Deploy now?",
      options: ["Deploy", "Wait"],
    });

    const wake = {
      key: "telegram:tap:1",
      to: "-100:7",
      from: "telegram",
      author: "owner",
      body: "Wait",
    } satisfies NewRow;

    expect(() =>
      store.write(() => {
        store.questions.answered("telegram", "-100:7", 41, "Wait", "telegram");
        throw new Error("killed before the wake was kept");
      }),
    ).toThrow("killed");
    expect(store.questions.get("telegram", "-100:7", 41)).toMatchObject({ message: 41 });
    expect(store.questions.get("telegram", "-100:7", 41)?.answer).toBeUndefined();
    expect(
      store.write(
        () =>
          store.questions.answered("telegram", "-100:7", 41, "Wait", "telegram") &&
          store.messages.deliver(wake),
      ),
    ).toBe(true);
    expect(
      store.write(
        () =>
          store.questions.answered("telegram", "-100:7", 41, "Deploy", "telegram") &&
          store.messages.deliver({ ...wake, key: "telegram:tap:2", body: "Deploy" }),
      ),
    ).toBe(false);
    expect(store.messages.get("telegram:tap:2")).toBeNull();
  },
);

inEachHome(
  "messages kept under a sender's name get one of hex's five authors, and keep the name in meta.user ($home)",
  ({ open }) => {
    const store = open(dir);
    store.db.run(
      "drop table pins; create table shown (session text primary key, digest text not null); alter table seen drop column at; drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))",
    );
    store.db.run("drop table turns; drop table relays");
    store.db.run("create index unauthored on messages (n) where author = ''");
    store.atMigration(15);

    const kept = (key: string, from: string, author: string, meta?: Record<string, string>) =>
      store.db
        .query(
          'insert into messages (key, "to", "from", author, body, meta, at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          key,
          "-100:7",
          from,
          author,
          "hi",
          meta === undefined ? null : JSON.stringify(meta),
          "2026-10-21T10:00:00.000Z",
        );

    kept("telegram:1", "telegram", "hex General", { user: "hex General" });
    kept("job:a:1", "job", "job");
    kept("schedule:b@1", "schedule", "schedule", { user: "schedule" });
    kept("buzz:2", "buzz", "buzz:abc", { user: "Ana", user_id: "abc" });
    kept("t3:3", "t3", "t3");
    kept("discord:4", "discord", "discord");
    kept("telegram:5", "telegram", "owner", { user_id: "1" });
    kept("telegram:6", "telegram", "", { user_id: "1" });
    expect(
      store
        .reopened()
        .messages.since()
        .map(({ key, author, meta }) => [key, author, meta?.user]),
    ).toEqual([
      ["telegram:1", "prompt", "hex General"],
      ["job:a:1", "prompt", "job"],
      ["schedule:b@1", "prompt", "schedule"],
      ["buzz:2", "other", "Ana"],
      ["t3:3", "other", "t3"],
      ["discord:4", "other", "discord"],
      ["telegram:5", "owner", undefined],
      ["telegram:6", "owner", undefined],
    ]);
  },
);

inEachHome(
  "a message's author is the owner, hex, a prompt (what hex itself tells a session: a job's end, a schedule, another thread, the hub), a call or someone other ($home)",
  ({ open }) => {
    const store = open(dir);
    expect(() =>
      store.messages.deliver({
        key: "telegram:-100:90",
        to: "-100:7",
        from: "telegram",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion anti-slop/require-safety-comment-for-type-assertion -- no author, to show the store refuses it
        author: "" as never,
        body: "hi",
      }),
    ).toThrow("owner, hex, prompt, call or other");
    expect(() =>
      store.messages.deliver({
        key: "job:x:1",
        to: "-100:7",
        from: "job",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion anti-slop/require-safety-comment-for-type-assertion -- an author outside the five, to show the store refuses it
        author: "job" as never,
        body: "hi",
      }),
    ).toThrow("owner, hex, prompt, call or other");
    expect(
      store.messages.deliver({
        key: "telegram:-100:91",
        to: "-100:7",
        from: "telegram",
        author: "other",
        body: "hi",
      }),
    ).toBe(true);
  },
);

inEachHome(
  "the profile is its newest version, put in place only over the one a writer read, and every version stays ($home)",
  ({ open }) => {
    const store = open(dir);
    expect(store.profiles.current()).toBe("");
    expect(store.profiles.profiled("", "# Who he is\n- Ships on fridays\n")).toBe(true);
    expect(store.profiles.profiled("", "# Who he is\n- Ships any day")).toBe(false);
    expect(
      store.profiles.profiled("# Who he is\n- Ships on fridays", "# Who he is\n- Ships on fridays"),
    ).toBe(true);
    expect(
      store.profiles.profiled("# Who he is\n- Ships on fridays", "# Who he is\n- Ships any day"),
    ).toBe(true);
    expect(store.profiles.current()).toBe("# Who he is\n- Ships any day");
    expect(store.profiles.list().map(({ body }) => body)).toEqual([
      "# Who he is\n- Ships any day",
      "# Who he is\n- Ships on fridays",
    ]);
  },
);

inEachHome(
  "a profile kept in state/profile.md comes into the records with its history, in order and once each, and the files move aside ($home)",
  ({ open }) => {
    writeFileSync(join(dir, "profile.md"), "# Who he is\n- Third\n");

    const history = [
      { at: "2026-10-21T13:00:00.000Z", profile: "# Always\n- First" },
      { at: "2026-10-21T13:32:54.590Z", profile: "# Always\n- First" },
      { at: "2026-10-21T15:09:00.000Z", profile: "# Who he is\n- Second" },
    ];

    writeFileSync(
      join(dir, "profile.md.history"),
      `${history.map((each) => JSON.stringify(each)).join("\n")}\n{"at": "broken\n`,
    );
    const store = open(dir);
    expect(store.profiles.list().map(({ body }) => body)).toEqual([
      "# Who he is\n- Third",
      "# Who he is\n- Second",
      "# Always\n- First",
    ]);
    expect(store.profiles.list()[1]?.at).toBe("2026-10-21T13:32:54.590Z");
    expect(store.profiles.list()[2]?.at).toBe("2026-10-21T13:00:00.000Z");
    expect(readFileSync(join(dir, "profile.md.moved-to-hex.db"), "utf-8")).toBe(
      "# Who he is\n- Third\n",
    );
    expect(running(store, "delete from profiles")).toThrow("never taken away");
  },
);

inEachHome(
  "a carry that renamed the profile files and then failed to commit carries them from their new names ($home)",
  ({ open }) => {
    writeFileSync(join(dir, "profile.md.moved-to-hex.db"), "# Who he is\n- Third\n");
    expect(open(dir).profiles.current()).toBe("# Who he is\n- Third");
  },
);

inEachHome(
  "a task quotes the owner's edit under the edit's own key, and names that key when quoted under the first ($home)",
  ({ open }) => {
    const store = open(dir);
    const said = { to: "-100:7", from: "telegram", author: "owner" } as const;
    store.messages.deliver({
      ...said,
      key: "telegram:-100:52",
      body: "Tell watchdog, so it can be fixed next run",
    });
    store.messages.deliver({
      ...said,
      key: "telegram:-100:52@1",
      body: "Tell watchdog, so it can be fixed properly at the root next run",
      meta: { edited: "true", message_id: "52" },
    });

    const task = store.tasks.create({
      title: "Fix it at the root",
      message: "telegram:-100:52",
      quote: "Tell watchdog",
      owner: "-100:7",
    });

    expect(() =>
      store.tasks.addWords(task.id, "telegram:-100:52", "fixed properly at the root"),
    ).toThrow(
      "is in telegram:-100:52@1, the owner's edit of telegram:-100:52: quote it under that key",
    );
    expect(
      store.tasks.addWords(task.id, "telegram:-100:52@1", "fixed properly at the root").words,
    ).toMatchObject([
      { text: "Tell watchdog" },
      { message: "telegram:-100:52@1", text: "fixed properly at the root" },
    ]);
    expect(() => store.tasks.addWords(task.id, "telegram:-100:52", "tonight")).toThrow(
      "isn't in telegram:-100:52 as written",
    );
  },
);

inEachHome(
  "each job's record from before the store kept them carries in once, with how it stopped, and an ended or unreadable one stays out ($home)",
  ({ open }) => {
    const store = open(dir);
    store.db.run("drop table jobs");
    store.atMigration(appendOnlyMigrations.findIndex(({ name }) => name === "carryJobRecords") - 1);
    store.seen.show("job:moved", "stopped", "moved");
    store.seen.show("job:finished", "stopped", "ended");

    const jobs = join(dir, "jobs");
    const spec = { owner: "t3:stray-key", cwd: "/work", properties: [], command: ["make", "all"] };
    mkdirSync(jobs);

    for (const unit of ["moved", "finished", "plain", "closed"]) {
      writeFileSync(
        join(jobs, `${unit}.json`),
        JSON.stringify({
          ...spec,
          machine: unit === "plain" ? undefined : "twin-x",
          started: `2026-11-15T10:0${String(unit.length)}:00.000Z`,
        }),
      );
    }

    writeFileSync(join(jobs, "closed.ended"), "2026-11-15T11:00:00.000Z");
    writeFileSync(join(jobs, "broken.json"), "{");
    writeFileSync(join(jobs, "plain.sync-conflict-20261113-010055-ABC.json"), "{}");

    const after = store.reopened();
    const [moved, plain, ...more] = after.jobs.list();

    expect(moved).toMatchObject({
      unit: "moved",
      machine: "twin-x",
      run: "2026-11-15T10:05:00.000Z",
      spec,
    });
    expect(moved?.stopped?.why).toBe("moved");
    expect(plain).toEqual({
      unit: "plain",
      machine: hostname(),
      run: "2026-11-15T10:05:00.000Z",
      spec,
      stopped: undefined,
    });
    expect(more).toEqual([]);
    expect(after.seen.get("job:moved", "stopped")).toBe("");
    expect(after.seen.get("job:finished", "stopped")).toBe("");
    expect(existsSync(join(jobs, "plain.json"))).toBe(true);
  },
);
