import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asked, brief, check, ruleEdit } from "./intent.ts";
import type { Kind, Verdict } from "./intent.ts";
import { open } from "./store.ts";
import type { Store } from "./store.ts";

const ok = (): Promise<Verdict> => Promise.resolve({ verdict: "ok", notes: "" });

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intent-"));
  mkdirSync(join(dir, "telegram"));
  store = open(dir);
  store.threads.keep("telegram", { "-100:7": { name: "Website" } });
  store.messages.deliver({
    key: "telegram:-100:50",
    to: "-100:7",
    from: "telegram",
    body: "Make the login page load fast.",
    author: "owner",
    meta: { user: "owner" },
  });
  store.messages.take("telegram:-100:50", "main");
  store.messages.deliver({
    key: "telegram:-100:51",
    to: "-100:7",
    from: "telegram",
    body: "On it.",
    author: "hex",
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a brief is what hands work to another agent", () => {
  writeFileSync(join(dir, "prompt.md"), "Fix the login page.");

  const job = brief({
    tool_name: "Bash",
    tool_input: { command: `cd ~/hex && .hex/bin/job login claude -p "$(cat ${dir}/prompt.md)"` },
  });

  expect(job).toContain("Fix the login page.");
  expect(
    brief({
      tool_name: "Bash",
      cwd: dir,
      tool_input: { command: 'claude -p --model opus "$(cat ./prompt.md)"' },
    }),
  ).toContain("Fix the login page.");
  expect(
    brief({
      tool_name: "Bash",
      tool_input: {
        command:
          "cd ~/hex && .hex/bin/hex deliver hex --to=-100:7 --user 'hex General' 'Make login fast.'",
      },
    }),
  ).toContain("Make login fast.");
  expect(
    brief({ tool_name: "Bash", tool_input: { command: 'ssh mac codex exec "Fix login."' } }),
  ).toContain("Fix login.");
  expect(
    brief({
      tool_name: "SendMessage",
      tool_input: { to: "login-fix", message: "Also the signup page." },
    }),
  ).toContain("signup");
  expect(
    brief({
      tool_name: "mcp__t3-code__t3_thread_send",
      tool_input: { threadId: "t", message: "Look again." },
    }),
  ).toContain("Look again.");
  expect(brief({ tool_name: "Bash", tool_input: { command: "git status" } })).toBeUndefined();
  expect(
    brief({ tool_name: "Bash", tool_input: { command: 'rg "hex deliver" hub; pgrep -f claude' } }),
  ).toBeUndefined();
  expect(
    brief({
      tool_name: "Agent",
      tool_input: { prompt: "Read the store and tell me how tasks work." },
    }),
  ).toBeUndefined();
  expect(
    brief({ tool_name: "Agent", tool_input: { prompt: "Task t-3: fix the login page." } }),
  ).toContain("t-3");
  expect(
    brief({
      tool_name: "mcp__plugin_telegram_telegram__new_thread",
      tool_input: { prompt: "Fix it." },
    }),
  ).toContain("Fix it.");
});

test("the words a brief is checked against: its tasks and the newest this session got", () => {
  const task = store.tasks.create({
    title: "Fast login",
    message: "telegram:-100:50",
    owner: "-100:7",
  });

  const words = asked(store, "main", `Task ${task.id}: make login fast.`);
  expect(words).toContain(`${task.id} (open`);
  expect(words).toContain(
    "this session got, oldest first, mine and the work hex handed it:\n\n[telegram:-100:50 · ",
  );
  expect(words).toContain("Z] me:\nMake the login page load fast.");
  expect(words).not.toContain("On it.");
});

test("work hex handed a session is read next to his words, newest last", () => {
  store.messages.deliver(
    {
      key: "hex:general-1",
      to: "-100:7",
      from: "hex",
      body: "hex bug: jobs started by the service can't find npm.",
      author: "prompt",
      meta: { user: "hex General" },
    },
    "main",
  );
  store.messages.deliver(
    {
      key: "terminal:job-1",
      to: "-100:7",
      from: "terminal",
      body: "Fix the service PATH for every hex user.",
      author: "prompt",
      meta: { session: "job" },
    },
    "job",
  );

  const main = asked(store, "main", "claude -p 'Fix the service PATH.'");
  expect(main.indexOf("Make the login page")).toBeLessThan(main.indexOf("hex bug: jobs"));
  expect(main).toContain("handed to it by hex General:\nhex bug: jobs");

  const job = asked(store, "job", "hex deliver hex --to=Website 'Run the PATH probe.'");
  expect(job).toContain("the prompt it started with:\nFix the service PATH");
  expect(job).toContain("which that thread's own session answers:\n\n[telegram:-100:50");
});

test("what a session said since its newest ask shows where that work stands", () => {
  store.messages.deliver(
    {
      key: "terminal:resume",
      to: "-100:7",
      from: "terminal",
      body: "Give the builder its go on the webrtc update.",
      author: "prompt",
      meta: { session: "orch" },
    },
    "orch",
  );

  for (const [key, body] of [
    ["terminal:r1", "I gave the builder the go on webrtc."],
    ["terminal:r2", "webrtc is on main and on the phone."],
  ] as const) {
    store.messages.deliver({ key, to: "-100:7", from: "terminal", body, author: "hex" }, "orch");
  }

  const words = asked(store, "orch", "SendMessage to its builder: fix the crash on launch.");
  expect(words.indexOf("Give the builder its go")).toBeLessThan(
    words.indexOf("What this session has said since, newest last:"),
  );
  expect(words.indexOf("I gave the builder the go")).toBeLessThan(
    words.indexOf("webrtc is on main"),
  );
  expect(asked(store, "main", "claude -p 'Make login fast.'")).not.toContain("said since");
});

test("a job is held to its own task, not to what the owner said to its thread since", () => {
  const task = store.tasks.create({
    title: "Fast login",
    message: "telegram:-100:50",
    owner: "-100:7",
  });

  store.tasks.addAgents(task.id, ["job-session"]);
  store.messages.deliver({
    key: "telegram:-100:52",
    to: "-100:7",
    from: "telegram",
    body: "New project: a fan controller, in its own topic.",
    author: "owner",
    meta: { user: "owner" },
  });
  store.messages.take("telegram:-100:52", "main");

  const words = asked(store, "job-session", "SendMessage to its builder: inline the login CSS.");
  expect(words).toContain(`${task.id} (open`);
  expect(words).not.toContain("fan controller");
});

test("a delivery is checked against the words it cites and the thread it goes to", () => {
  store.threads.keep("telegram", { "-100:7": { name: "Website" }, "-100:9": { name: "General" } });
  store.messages.deliver({
    key: "telegram:-100:90",
    to: "-100:9",
    from: "telegram",
    body: "Dark mode too, please.",
    author: "owner",
    meta: { user: "owner" },
  });

  const words = asked(
    store,
    "general",
    ".hex/bin/hex deliver hex --to=Website 'Add dark mode (telegram:-100:90).'",
  );

  expect(words).toContain("My messages it cites:\n\n[telegram:-100:90");
  expect(words).toContain("session answers:\n\n[telegram:-100:50");
  expect(words).not.toContain("this session got");
});

test("a rewrite is checked next to the notes it answers, and goes through after two sendbacks", async () => {
  const hook = {
    session_id: "s",
    tool_name: "Agent",
    tool_input: { prompt: "Task t-1: rewrite the whole site." },
  };

  const seen: string[] = [];

  const revise = (input: string): Promise<Verdict> => {
    seen.push(input);

    return Promise.resolve({ verdict: "revise", notes: "He asked for the login page only." });
  };

  expect(await check(hook, store, revise)).toMatchObject({
    round: 1,
    verdict: { verdict: "revise" },
  });
  expect(seen[0]).not.toContain("went back with your notes");
  expect(await check(hook, store, revise)).toMatchObject({
    round: 2,
    verdict: { verdict: "revise" },
  });
  expect(seen[1]).toContain("went back with your notes");
  expect(seen[1]).toContain("He asked for the login page only.");
  expect(await check(hook, store, revise)).toMatchObject({
    round: 3,
    through: true,
  });
  expect(await check(hook, store, revise)).toMatchObject({ round: 1 });
  expect(await check(hook, store, ok)).toMatchObject({
    round: 2,
    verdict: { verdict: "ok" },
  });
  expect(await check(hook, store, revise)).toMatchObject({ round: 1 });
});

test("a check that fails lets the work start", async () => {
  const hook = {
    session_id: "s",
    tool_name: "Agent",
    tool_input: { prompt: "Task t-1: fix login." },
  };

  const result = await check(hook, store, () => Promise.reject(new Error("out of usage")));

  expect(result?.verdict).toBe("failed");
});

test("a change to the rules is what writes a rule file", () => {
  const rules = join(dir, "AGENTS.md");
  writeFileSync(rules, "- Update what of ours is out of date yourself.\n");
  writeFileSync(join(dir, "notes.md"), "");

  const edit = (tool_name: string, tool_input: Record<string, string>) =>
    ruleEdit({ tool_name, tool_input, cwd: "/" }, [rules]);

  const sed = `cd ${dir} && enclave get machines password | sudo -S chattr -i AGENTS.md && sed -i '1s/.*/- Update it. When an update breaks something, fix ours./' AGENTS.md`;
  expect(edit("Bash", { command: sed })).toBe(sed);
  expect(edit("Bash", { command: `echo '- A new line.' >> ${rules}` })).toBeDefined();
  expect(edit("Bash", { command: `cd ${dir} && git checkout HEAD~1 -- AGENTS.md` })).toBeDefined();
  expect(
    edit("Edit", { file_path: rules, old_string: "yourself.", new_string: "yourself. And more." }),
  ).toContain("And more.");

  expect(
    edit("Bash", {
      command: `cd ${dir} && rg -n 'Update' AGENTS.md; lsattr AGENTS.md 2>/dev/null`,
    }),
  ).toBeUndefined();
  expect(edit("Bash", { command: `rg -n Update ${rules} > ${dir}/found.txt` })).toBeUndefined();
  expect(edit("Bash", { command: `cd ${dir} && sed -i 's/a/b/' notes.md` })).toBeUndefined();
  expect(edit("Bash", { command: `cp ${rules} ${dir}/rules.before` })).toBeUndefined();
  expect(
    edit("Bash", { command: `rg -n Update ${rules}; sed -i 's/a/b/' ${dir}/notes.md` }),
  ).toBeUndefined();
  expect(
    edit("Bash", { command: `cd ${dir} && git add AGENTS.md && git commit -m 'install it'` }),
  ).toBeUndefined();
  expect(
    edit("Bash", { command: `cd ${dir} && cd elsewhere && sed -i 's/a/b/' AGENTS.md` }),
  ).toBeUndefined();
  expect(edit("Bash", { command: `git -C ${dir} checkout HEAD~1 -- AGENTS.md` })).toBeDefined();
  expect(edit("Bash", { command: `cp ${dir}/notes.md ${rules}` })).toBeDefined();
  expect(
    edit("Edit", { file_path: join(dir, "notes.md"), old_string: "", new_string: "x" }),
  ).toBeUndefined();
});

test("a change to the rules is checked against the owner's words, apart from briefs", async () => {
  const rules = join(dir, "AGENTS.md");
  writeFileSync(rules, "");

  const hook = {
    session_id: "main",
    tool_name: "Bash",
    tool_input: { command: `echo '- Login pages load fast.' >> ${rules}` },
  };

  const seen: [string, Kind | undefined][] = [];

  const revise = (input: string, kind?: Kind): Promise<Verdict> => {
    seen.push([input, kind]);

    return Promise.resolve({
      verdict: "revise",
      notes: "He asked for a fast login page, not a rule.",
    });
  };

  expect(await check(hook, store, revise, [rules])).toMatchObject({
    kind: "rules",
    round: 1,
    verdict: { verdict: "revise" },
  });
  expect(seen[0]?.[1]).toBe("rules");
  expect(seen[0]?.[0]).toContain("Make the login page load fast.");
  expect(seen[0]?.[0]).toContain("The change to my rules (Bash)");

  const handOff = {
    session_id: "main",
    tool_name: "Agent",
    tool_input: { prompt: "Task t-1: fix login." },
  };

  expect(await check(handOff, store, revise, [rules])).toMatchObject({ kind: "brief", round: 1 });
  expect(seen[1]?.[1]).toBe("brief");

  const handOffWritingRules = {
    session_id: "other",
    tool_name: "Bash",
    tool_input: { command: `claude -p "Task t-2: tidy the rules." | tee -a ${rules}` },
  };

  expect(await check(handOffWritingRules, store, revise, [rules])).toMatchObject({ kind: "brief" });
});
