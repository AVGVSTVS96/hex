import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { above } from "./fit.ts";
import { statusPost } from "./status.ts";
import { Store } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "status-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const said = (store: Store, n: number, body: string) => {
  const key = `telegram:-100:${n}`;
  store.deliver({
    key,
    to: "-100:7",
    from: "telegram",
    body,
    author: "owner",
    meta: { user: "owner" },
  });
  return key;
};

test("a status post is the note over the thread's waiting questions, open tasks and the last five done", () => {
  const store = new Store(dir);
  const note = "Site: https://example.com";
  expect(statusPost(store, "-100:7", note, 4096)).toBe(note);

  store.ask({
    app: "telegram",
    thread: "-100:7",
    message: 60,
    text: "Ship today?\nCI is green.",
    options: ["Yes", "No"],
  });
  store.ask({
    app: "telegram",
    thread: "-100:8",
    message: 61,
    text: "Elsewhere?",
    options: ["Yes", "No"],
  });
  const open = store.createTask({
    title: "Fix the login page",
    message: said(store, 50, "Fix the login page"),
    owner: "-100:7",
  });
  const old = store.createTask({
    title: "Rename the repo",
    message: said(store, 52, "Rename the repo"),
    owner: "-100:7",
  });
  const done = store.createTask({
    title: "Blur the logo less",
    message: said(store, 51, "Blur the logo less"),
    owner: "-100:7",
  });
  store.createTask({
    title: "Not this thread",
    message: said(store, 53, "Not this thread"),
    owner: "-100:8",
  });
  store.editTask(old.id, { status: "done", proof: "gh repo rename" });
  store.editTask(done.id, {
    status: "done",
    proof: "shipped in abc123, https://example.com/pull/3.",
  });

  expect(statusPost(store, "-100:7", note, 4096)).toBe(
    [
      note,
      "**Waiting on you**\n- Ship today?",
      "**Open**\n- Fix the login page",
      "**Done**\n- [Blur the logo less](https://example.com/pull/3)\n- Rename the repo",
    ].join("\n\n"),
  );
  expect(
    statusPost(
      store,
      "-100:7",
      note,
      4096,
      (thread, message) => `https://t.me/c/${thread}/${message}`,
    ),
  ).toContain("**Waiting on you**\n- [Ship today?](https://t.me/c/-100:7/60)\n\n");

  for (let n = 54; n < 58; n++)
    store.editTask(
      store.createTask({
        title: `Later ${n}`,
        message: said(store, n, `Later ${n}`),
        owner: "-100:7",
      }).id,
      { status: "done", proof: "ok" },
    );
  const latest = statusPost(store, "-100:7", note, 4096);
  expect(latest).toContain("- [Blur the logo less]");
  expect(latest).not.toContain("Rename the repo");
});

test("a status post fits the room the app gives one message, saying how many more there are", () => {
  const store = new Store(dir);
  for (let n = 0; n < 40; n++)
    store.createTask({
      title: `Task number ${n} with enough words to take some room`,
      message: said(store, n, `Task number ${n} with enough words to take some room`),
      owner: "-100:7",
    });
  for (let room = 300; room <= 2100; room += 7)
    expect(statusPost(store, "-100:7", "Note", room).length).toBeLessThanOrEqual(room);
  const long = statusPost(store, "-100:7", "x".repeat(3000), 2000);
  expect(long.length).toBeLessThanOrEqual(2000);
  expect(long).toMatch(/^x+…\n\n\*\*Open\*\*\n…and 40 more$/);
  const text = statusPost(store, "-100:7", "Note", 2000);
  expect(text).toMatch(/\n…and \d+ more$/);
});

test("a done task links to the first link in its proof, without the markdown or punctuation around it", () => {
  const store = new Store(dir);
  const proofs = [
    "merged in `https://github.com/o/r/pull/3`.",
    "(see https://en.wikipedia.org/wiki/Foo_(bar))",
    "**https://example.com/a**",
    "commit abc123",
  ];
  proofs.forEach((proof, n) =>
    store.editTask(
      store.createTask({
        title: `Task ${n}`,
        message: said(store, 70 + n, `Task ${n}`),
        owner: "-100:7",
      }).id,
      { status: "done", proof },
    ),
  );
  expect(statusPost(store, "-100:7", "Note", 4096).split("**Done**\n")[1]!.split("\n")).toEqual([
    "- Task 3",
    "- [Task 2](https://example.com/a)",
    "- [Task 1](https://en.wikipedia.org/wiki/Foo_(bar))",
    "- [Task 0](https://github.com/o/r/pull/3)",
  ]);
});

test("a status post's note is its words above its first heading, plain or an older post's 🔴 🟡 🟢 one", () => {
  expect(above("📌 **desk**\nShipping today\n\n**Waiting on you**\n- old\n\n**Done**\n- x")).toBe(
    "📌 **desk**\nShipping today",
  );
  expect(above("Note\n**Open**\n- old")).toBe("Note");
  expect(above("Done when **Open** ships")).toBe("Done when **Open** ships");
  expect(above("📌 **desk**\nShipping today\n\n🔴 **Blocked on you**\n- old\n\n🟢 Done")).toBe(
    "📌 **desk**\nShipping today",
  );
  expect(above("Just a note")).toBe("Just a note");
  expect(above("Deploy is 🟢 for Friday\n🟢 Live at example.com\n## 🟡 In review")).toBe(
    "Deploy is 🟢 for Friday\n🟢 Live at example.com\n## 🟡 In review",
  );
  expect(above("Note\n**🔴 Blocked on you:** no questions waiting")).toBe("Note");
  expect(above("Note\n## 🟡 Pending\n- old")).toBe("Note");
});

test("an open task links to the owner's latest words for it in the thread, to reply to with more", () => {
  const store = new Store(dir);
  const task = store.createTask({
    title: "Fix the login page",
    message: said(store, 50, "Fix the login page"),
    owner: "-100:7",
  });
  store.addWords(task.id, said(store, 58, "and the signup page"));
  store.deliver({
    key: "telegram:42:90",
    to: "42",
    from: "telegram",
    body: "one more thing",
    author: "owner",
  });
  store.addWords(task.id, "telegram:42:90");
  expect(
    statusPost(
      store,
      "-100:7",
      "Note",
      4096,
      (thread, message) => `https://t.me/c/${thread}/${message}`,
    ),
  ).toContain("**Open**\n- [Fix the login page](https://t.me/c/-100:7/58)");
});

test("the owner's question hex answered waits on them, linked to the answer, and ideas get their own list", () => {
  const store = new Store(dir);
  store.ask({
    asker: "owner",
    app: "telegram",
    thread: "-100:7",
    message: 70,
    text: "did the migration run?",
    options: [],
  });
  expect(statusPost(store, "-100:7", "Note", 4096)).toBe("Note");
  store.replied("telegram", "-100:7", {
    label: "Yes, at 4:02pm.",
    at: new Date().toISOString(),
    via: "hex",
    message: 72,
  });
  store.createTask({
    title: "Maybe a dark mode",
    message: said(store, 71, "Maybe a dark mode"),
    owner: "-100:7",
    status: "idea",
  });
  expect(
    statusPost(
      store,
      "-100:7",
      "Note",
      4096,
      (thread, message) => `https://t.me/c/${thread}/${message}`,
    ),
  ).toBe(
    [
      "Note",
      "**Waiting on you**\n- [Answered: did the migration run?](https://t.me/c/-100:7/72)",
      "**Ideas**\n- [Maybe a dark mode](https://t.me/c/-100:7/71)",
    ].join("\n\n"),
  );
  expect(above("Note\n\n**Ideas**\n- Maybe a dark mode")).toBe("Note");
});
