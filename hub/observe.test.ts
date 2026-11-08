import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clock, drain, nap, observe, within } from "./observe.ts";
import type { Answer, Pass } from "./observe.ts";
import { open } from "./store.ts";

let dir: string;
const none: Answer = { notes: [], profile: null };
let memo: string;

const answering =
  (seen: string[], answer: () => Answer = () => none) =>
  (input: string) => {
    seen.push(input);

    return Promise.resolve(answer());
  };

const next = (list: string[]) => {
  const first = list.shift();

  if (first === undefined) {
    throw new Error("asked once more than the test planned");
  }

  return first;
};

const limitHit = () => Promise.reject(new Error("limit"));

const drainingInto =
  (seen: string[], prefix = "") =>
  (turn: Pass) => {
    seen.push(`${prefix}${turn.session}`);

    return Promise.resolve();
  };

const noted = () =>
  existsSync(join(dir, "noted"))
    ? readFileSync(join(dir, "noted"), "utf-8").trim().split("\n")
    : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "observe-"));
  memo = join(dir, "memo");
  writeFileSync(
    join(dir, "memories"),
    '#1 2026-10-19 Oct 19 9pm: the owner wants "the login page fixed first" [telegram:-100:40]\n',
  );
  writeFileSync(
    memo,
    `#!/bin/sh\ncase "$1" in\n  note) printf '%s\\n' "$2" >> "${dir}/noted" ;;\n  recall) grep -E -- "$2" "${dir}/memories" ;;\nesac\n`,
  );
  chmodSync(memo, 0o755);
  const store = open(dir);
  store.messages.deliver({
    key: "telegram:-100:40",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "get the login page fixed first",
    meta: { user_id: "1" },
  });
  store.messages.deliver({
    key: "telegram:-100:50",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "ship it on fridays only, my team reviews thursdays",
    meta: { user_id: "1", ts: "2026-10-20T06:31:00.000Z" },
  });
  store.messages.deliver({
    key: "schedule:nightly:1",
    to: "-100:7",
    from: "schedule",
    author: "prompt",
    body: "[nightly] run the backup",
    meta: {},
  });

  for (const key of ["telegram:-100:40", "telegram:-100:50", "schedule:nightly:1"]) {
    store.messages.take(key, "s");
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the turn's messages reach the pass, which writes notes for the owner's no note names yet", async () => {
  const seen: string[] = [];

  const ask = answering(seen, () => ({
    notes: [
      'Oct 19 11:31pm: ships "on fridays only, my team reviews thursdays" [telegram:-100:50]',
    ],
    profile: null,
  }));

  open(dir).messages.deliver(
    {
      key: "telegram:-100:51",
      to: "-100:7",
      from: "telegram",
      author: "hex",
      body: "Done, Friday deploys only.",
    },
    "s",
  );
  expect(await observe(dir, "s", { ask, memo })).toHaveLength(1);
  expect(seen[0]).toContain("[telegram:-100:50]");
  expect(seen[0]).toMatch(/hex replied, [^\n]*:\nDone, Friday deploys only\./u);
  expect(seen[0]).toContain(
    "get the login page fixed first\n(a note already names this message: write no note for it)",
  );
  expect(seen[0]).toContain("hex's words to the session,");
  expect(seen[0]).toContain("[nightly] run the backup");
  expect(noted()).toEqual([
    'Oct 19 11:31pm: ships "on fridays only, my team reviews thursdays" [telegram:-100:50]',
  ]);
  expect(await observe(dir, "s", { ask, memo })).toEqual([]);
  expect(seen).toHaveLength(1);
});

test("a note that misquotes the owner, quotes without naming the message, or doesn't fit isn't written, one about what happened needs neither, and one is written without the date memo adds", async () => {
  const ask = answering([], () => ({
    profile: null,
    notes: [
      'Oct 19: ships "only on fridays" [telegram:-100:50]',
      'Oct 19: ships "on fridays only"',
      "Oct 19: the nightly backup ran",
      `Oct 19: "ship it on fridays only" ${"x".repeat(280)} [telegram:-100:50]`,
      '2026-10-19 Oct 19: "ship it on fridays only" [telegram:-100:50]',
      'Oct 19: answered "?" [telegram:-100:50]',
    ],
  }));

  expect(await observe(dir, "s", { ask, memo })).toEqual([
    "Oct 19: the nightly backup ran",
    'Oct 19: "ship it on fridays only" [telegram:-100:50]',
  ]);
  expect(noted()).toHaveLength(2);
});

test("a pass that fails hands its messages to the next one, and one that died does once its lease runs out", async () => {
  expect(await observe(dir, "s", { ask: limitHit, memo })).toEqual([]);

  const asked: string[] = [];
  await observe(dir, "s", { ask: answering(asked), memo });
  expect(asked).toHaveLength(1);

  const store = open(dir);
  store.messages.deliver({
    key: "telegram:-100:60",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "move standup to 10",
    meta: { user_id: "1" },
  });
  store.messages.take("telegram:-100:60", "s");
  expect(store.messages.observe("s", new Date().toISOString()).map((row) => row.key)).toEqual([
    "telegram:-100:60",
  ]);
  expect(store.messages.observe("s", new Date().toISOString())).toEqual([]);
  await Bun.sleep(2);
  expect(
    store.messages.observe("s", new Date().toISOString(), undefined, 0).map((row) => row.key),
  ).toEqual(["telegram:-100:60"]);
});

test("a pass takes what the session had taken when its turn ended, not the next turn's message", async () => {
  const by = new Date().toISOString();
  await Bun.sleep(2);
  const store = open(dir);
  store.messages.deliver({
    key: "telegram:-100:70",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "and add a dark mode",
    meta: { user_id: "1" },
  });
  store.messages.take("telegram:-100:70", "s");
  const seen: string[] = [];
  await observe(dir, "s", { ask: answering(seen), memo, by });
  expect(seen[0]).toContain("[telegram:-100:50]");
  expect(seen[0]).not.toContain("dark mode");
  await observe(dir, "s", { ask: answering(seen), memo });
  expect(seen[1]).toContain("and add a dark mode");
});

test("a later session in the thread takes what an earlier one's pass left", async () => {
  await observe(dir, "s", { ask: limitHit, memo });

  const seen: string[] = [];
  await observe(dir, "t", { ask: answering(seen), memo, thread: "-100:7" });
  expect(seen[0]).toContain("[telegram:-100:50]");
});

test("a note may only name this pass's messages", async () => {
  const ask = answering([], () => ({
    notes: [
      'Oct 19: "get the login page fixed first" [telegram:-100:40]',
      'Oct 19: "run the backup" [schedule:nightly:1]',
    ],
    profile: null,
  }));

  expect(await observe(dir, "s", { ask, memo })).toEqual([]);
});

test("the profile is rewritten to the current truth, and one that misquotes the owner goes back to be fixed", async () => {
  const profile =
    '# Always\n- Ships "on fridays only" [telegram:-100:50]\n\n# Now\n- Login page first';

  const seen: string[] = [];
  await observe(dir, "s", { ask: answering(seen, () => ({ notes: [], profile })), memo });
  expect(seen[0]).toContain("<profile>\n(none yet)\n</profile>");
  expect(open(dir).profiles.current()).toBe(profile);

  const store = open(dir);
  store.messages.deliver({
    key: "telegram:-100:80",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "actually ship any day now",
    meta: { user_id: "1" },
  });
  store.messages.take("telegram:-100:80", "s");

  const answers = [
    '# Always\n- Ships "whenever" [telegram:-100:80]',
    '# Always\n- Ships "any day now" [telegram:-100:80]',
  ];

  const asked: string[] = [];
  await observe(dir, "s", {
    ask: answering(asked, () => ({ notes: [], profile: next(answers) })),
    memo,
  });
  expect(asked[1]).toContain("Your last profile wasn't kept");
  expect(asked[1]).toContain('- Ships "whenever" [telegram:-100:80]');
  expect(open(dir).profiles.current()).toBe('# Always\n- Ships "any day now" [telegram:-100:80]');
  expect(asked[1]).toContain(
    'Fix that draft rather than starting over:\n<draft>\n# Always\n- Ships "whenever" [telegram:-100:80]\n</draft>',
  );
  expect(store.profiles.list().map(({ body }) => body)).toEqual([
    '# Always\n- Ships "any day now" [telegram:-100:80]',
    profile,
  ]);
});

test("a summary still too long after its tries is cut at a word", () => {
  expect(within("short line", 280)).toBe("short line");
  const cut = within(`${"word ".repeat(70)}end`, 280);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(280);
  expect(cut).toMatch(/word…$/u);
});

test("a profile line may only quote the owner, by the key of the message it quotes", async () => {
  const answers = [
    '# Always\n- Wants "the login page fixed first"',
    '# Now\n- "run the backup" [schedule:nightly:1]',
    '# Always\n- Ships "on fridays only" [telegram:-100:50]',
  ];

  const asked: string[] = [];
  await observe(dir, "s", {
    ask: answering(asked, () => ({ notes: [], profile: next(answers) })),
    memo,
  });
  expect(asked[1]).toContain("names no message of the owner's for its quote");
  expect(asked[2]).toContain("[schedule:nightly:1] isn't the owner's message");
  expect(open(dir).profiles.current()).toBe(
    '# Always\n- Ships "on fridays only" [telegram:-100:50]',
  );
});

test("a profile that kept misquoting is logged and its turn is done, so it costs no more calls", async () => {
  const asked: string[] = [];
  await observe(dir, "s", {
    ask: answering(asked, () => ({
      notes: [],
      profile: '# Always\n- Wants "whatever" [telegram:-100:50]',
    })),
    memo,
  });
  expect(open(dir).profiles.current()).toBe("");
  await observe(dir, "s", { ask: answering(asked), memo });
  expect(asked).toHaveLength(3);
});

test("a time reads the way notes write it, on the owner’s clock", () => {
  expect(clock("2026-10-20T06:31:00.000Z", "America/Los_Angeles")).toBe("Oct 19 11:31pm");
  expect(clock("2026-10-20T19:05:00.000Z", "America/Los_Angeles")).toBe("Oct 20 12:05pm");
});

test("a turn that took no message still gets a pass from its reply, and a retry writes no note twice", async () => {
  await observe(dir, "s", { ask: answering([]), memo });
  open(dir).messages.deliver(
    {
      key: "terminal:answer",
      to: "s",
      from: "terminal",
      author: "hex",
      body: "The deck redo is live.",
    },
    "s",
  );
  const asked: string[] = [];

  const ask = answering(asked, () => ({
    notes: ["Oct 20: deck redo shipped"],
    profile: '- Wants "whatever" [telegram:-100:50]',
  }));

  expect(await observe(dir, "s", { ask, memo })).toEqual(["Oct 20: deck redo shipped"]);
  expect(asked).toHaveLength(3);
  expect(noted()).toEqual(["Oct 20: deck redo shipped"]);
});

test("an app session's last words in its terminal reach the pass as what the owner doesn't see", async () => {
  await observe(dir, "s", { ask: answering([]), memo });
  open(dir).messages.deliver(
    {
      key: "terminal:summed",
      to: "-100:7",
      from: "terminal",
      author: "hex",
      body: "Heartbeat: nothing new.",
      meta: { unsent: "true" },
    },
    "s",
  );
  const asked: string[] = [];
  await observe(dir, "s", { ask: answering(asked), memo });
  expect(asked[0]).toContain("hex, in its terminal, which the owner does not see,");
});

test("the Stop hook keeps a T3 turn's answer as hex's reply in T3, whatever prompted the turn", async () => {
  const hook = Bun.spawn([process.execPath, join(import.meta.dir, "state.ts"), "idle"], {
    stdin: new Blob([
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s",
        last_assistant_message: "Shipped, and checked live.",
      }),
    ]),
    env: {
      ...process.env,
      HEX_STORE: dir,
      HEX_THREAD: "t3-thread",
      HEX_CHANNEL: "plugin:t3@hex",
      HEX_HUB: "",
      MEMORY_DIR: "",
    },
  });

  expect(await hook.exited).toBe(0);
  const [answer] = open(dir).messages.said("t3-thread");
  expect(answer).toMatchObject({
    from: "t3",
    author: "hex",
    body: "Shipped, and checked live.",
    taken: { by: "s" },
  });
  expect(answer?.meta).toEqual({ session: "s" });
});

test("turns wait in hex.db and one drainer works through them oldest first, while a lease is held the turn waits for its holder", async () => {
  const store = open(dir);
  const seen: string[] = [];
  store.passes.wait({ session: "a", by: "" });
  store.passes.wait({ session: "b", by: "" });
  await Promise.all([drain(dir, drainingInto(seen)), drain(dir, drainingInto(seen, "2"))]);
  expect(seen).toEqual(["a", "b"]);
  expect(store.passes.waiting()).toBeUndefined();

  expect(store.leases.take("observe", "other", 60_000)).toBe(true);
  store.passes.wait({ session: "c", by: "" });
  await drain(dir, drainingInto(seen));
  expect(store.passes.waiting()?.pass).toEqual({ session: "c", by: "" });
  store.leases.release("observe", "other");
  expect(store.leases.take("observe", "dead", 0)).toBe(true);
  await Bun.sleep(2);
  await drain(dir, drainingInto(seen));
  expect(seen).toEqual(["a", "b", "c"]);
});

test("a holder renews its own lease, and a turn that throws leaves the queue to the next", async () => {
  const store = open(dir);
  expect(store.leases.take("observe", "me", 0)).toBe(true);
  expect(store.leases.take("observe", "me", 60_000)).toBe(true);
  await Bun.sleep(2);
  expect(store.leases.take("observe", "other", 60_000)).toBe(false);
  store.leases.release("observe", "me");
  store.passes.wait({ session: "bad", by: "" });
  store.passes.wait({ session: "good", by: "" });
  const seen: string[] = [];
  await drain(dir, (turn) =>
    turn.session === "bad" ? Promise.reject(new Error("boom")) : drainingInto(seen)(turn),
  );
  expect(seen).toEqual(["good"]);
  expect(store.passes.waiting()).toBeUndefined();
});

test("the memory agent does the compressions memo asks for, and a line memo turns down goes back with why", async () => {
  const napper = join(dir, "napper");
  writeFileSync(
    napper,
    `#!/bin/sh
[ -z "$2" ] && { [ -f "${dir}/napped" ] && echo 'Nothing left to compress.' || printf 'Compress memories #0-1 into one line of at most 20 bytes.\\n\\n  #0 a\\n  #1 b\\n\\nRun: memo nap 0-1 "<your line>"\\n'; exit 0; }
[ \${#3} -gt 20 ] && { echo 'Too long: compress it further.'; exit 1; }
printf '%s %s\\n' "$2" "$3" > "${dir}/napped"
`,
  );
  chmodSync(napper, 0o755);
  const asked: string[] = [];
  const lines = ["a and b, said at far too much length", "a and b"];
  await nap(napper, (prompt) => {
    asked.push(prompt);

    return Promise.resolve(next(lines));
  });
  expect(readFileSync(join(dir, "napped"), "utf-8")).toBe("0-1 a and b\n");
  expect(asked[0]).toStartWith("Compress memories #0-1");
  expect(asked[0]).not.toContain("Run:");
  expect(asked[1]).toContain("That line wasn't kept: Too long");
  rmSync(join(dir, "napped"));
  await nap(
    napper,
    () => Promise.resolve("never asked"),
    () => false,
  );
  expect(existsSync(join(dir, "napped"))).toBe(false);
  const failed = nap(napper, () => Promise.reject(new Error("API Error: 529")));
  expect(await failed.then(() => "", String)).toContain("529");
  expect(existsSync(join(dir, "napped"))).toBe(false);
});
