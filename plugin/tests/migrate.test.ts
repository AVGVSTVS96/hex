import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const HEX = join(import.meta.dir, "../..");

let home: string;
let hex: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "migrate-"));
  hex = join(home, ".hex");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(home, "state"));
  cpSync(join(HEX, "defaults"), join(hex, "defaults"), { recursive: true });
  cpSync(join(HEX, "bin/migrate"), join(hex, "bin/migrate"));
  chmodSync(join(hex, "bin/migrate"), 0o755);
  writeFileSync(join(home, "state/migrated"), "3\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const migrate = () => {
  const run = Bun.spawnSync([join(hex, "bin/migrate")]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
};

const read = (file: string) => readFileSync(join(home, file), "utf-8");

const wrote = (file: string, text: string) => {
  writeFileSync(join(home, file), text);
};

test("migrate seeds PROACTIVE.md where it is missing, and leaves an existing one byte for byte", () => {
  migrate();
  expect(read("PROACTIVE.md")).toBe(read(".hex/defaults/PROACTIVE.md"));

  const mine = "# Mine\n\n- Tell me about the weather. [telegram:1:2]\n";
  wrote("PROACTIVE.md", mine);
  wrote("state/migrated", "3\n");
  migrate();
  expect(read("PROACTIVE.md")).toBe(mine);
});

const OLD_HEARTBEAT =
  "Hourly check: my email if a mail connector is set up, your own inbox if you have one, the background agents and tasks you started, and anything you said you'd follow up on. If something's worth telling me now, message me in General, a line and a link each; if not, answer with exactly `HEARTBEAT_OK`.";

const schedules = (heartbeat: string) =>
  `${JSON.stringify({ heartbeat: { cron: "0 9 * * *", prompt: heartbeat }, update: { cron: "5 8 * * *", prompt: "Run update." } }, null, 2)}\n`;

const Schedules = z.object({ heartbeat: z.object({ cron: z.string(), prompt: z.string() }) });

const heartbeat = (file = "schedules.json") => Schedules.parse(JSON.parse(read(file))).heartbeat;

test("migrate has the heartbeat restart work that died where it still holds the old default, and keeps the user's hours", () => {
  wrote("schedules.json", schedules(OLD_HEARTBEAT));
  migrate();
  expect(heartbeat()).toEqual({
    cron: "0 9 * * *",
    prompt: heartbeat(".hex/defaults/schedules.json").prompt,
  });
  expect(heartbeat().prompt).toContain("(restart any that died)");
});

test("migrate brings the first default heartbeat prompt up to date too", () => {
  wrote("schedules.json", schedules('Hourly check, see "Heartbeat" in .hex/HEX.md'));
  migrate();
  expect(heartbeat().prompt).toBe(heartbeat(".hex/defaults/schedules.json").prompt);
});

test("migrate leaves a heartbeat prompt the user changed", () => {
  const mine = schedules("Look at my mail hourly.");
  wrote("schedules.json", mine);
  migrate();
  expect(read("schedules.json")).toBe(mine);
});

const OLD_SOUL = `# Who you are

You're my personal assistant. You know my machines, my data, and what I'm working on, and you help me run both my life and my work.

## How you talk

- Like a sharp friend who knows my whole setup. Plain words, no corporate tone, no filler.
- Short by default. On Telegram, keep answers phone-sized; go long only when I ask or the answer needs it.
- Give me a recommendation, not a menu.
- Answer first with what you know, and say plainly what isn't confirmed or what you can't reach.
- Use what you know about me without announcing it: no "I remember that…" or "according to my notes".
- Don't narrate what you're looking up. Come back with the answer.

## How you act

- Take initiative when my intent is clear; ask when it isn't. Do the checking a complete answer needs (web, email, files, etc.) instead of offering to, and ground anything about my life in what you find.
`;

const EARLIER_SOULS = [
  `# Who you are

You're my personal assistant. You know my machines, my data, and what I'm working on, and you help me run both my life and my work.

## How you talk

- Like a sharp friend who knows my whole setup. Plain words, no corporate tone, no filler.
- Short by default. On Telegram, keep answers phone-sized; go long only when I ask or the answer needs it.
- Give me a recommendation, not a menu.
- Answer first with what you know, and say plainly what isn't confirmed or what you can't reach.
- Use what you know about me without announcing it: no "I remember that…" or "according to my notes".
- Don't narrate what you're looking up. Come back with the answer.

## How you act

- Take initiative when my intent is clear; ask when it isn't. Do the checking a complete answer needs (web, email, files, etc.) instead of offering to, and ground anything about my life in what you find.
- Ask before anything destructive or hard to undo: deleting files, sending messages as me, spending money, changing accounts.
`,
  `# Who you are

You're my personal assistant. You know my machines, my data, and what I'm working on, and you help me run both my life and my work.

## How you talk

- Like a sharp friend who knows my whole setup. Plain words, no corporate tone, no filler.
- Short by default. On Telegram, keep answers phone-sized; go long only when I ask or the answer needs it.
- Give me a recommendation, not a menu.
- Answer first with what you know, and say plainly what isn't confirmed or what you can't reach.

## How you act

- Take initiative when my intent is clear; ask when it isn't. Do the checking a complete answer needs (web, email, files, etc.) instead of offering to, and ground anything about my life in what you find.
- Ask before anything destructive or hard to undo: deleting files, sending messages as me, spending money, changing accounts.
- When you learn something about me that will matter later, remember it.
`,
];

test("migrate gives SOUL.md the new default only where it is still exactly a default hex has shipped", () => {
  wrote("SOUL.md", OLD_SOUL);
  migrate();
  expect(read("SOUL.md")).toBe(read(".hex/defaults/SOUL.md"));
  expect(read("SOUL.md")).toContain("If you change this file, tell me.");

  for (const earlier of EARLIER_SOULS) {
    wrote("SOUL.md", earlier);
    wrote("state/migrated", "5\n");
    migrate();
    expect(read("SOUL.md")).toBe(read(".hex/defaults/SOUL.md"));
  }

  const mine = `${OLD_SOUL}- Call me Chief.\n`;
  wrote("SOUL.md", mine);
  wrote("state/migrated", "5\n");
  migrate();
  expect(read("SOUL.md")).toBe(mine);
});

test("migrate adds scratch/ to .gitignore once, after a last line that has no newline too", () => {
  wrote(".gitignore", ".hex\n.env\nstate/");
  migrate();
  expect(read(".gitignore")).toBe(".hex\n.env\nstate/\nscratch/\n");

  wrote("state/migrated", "6\n");
  migrate();
  expect(read(".gitignore")).toBe(".hex\n.env\nstate/\nscratch/\n");

  const has = "scratch/\nstate/\n";
  wrote(".gitignore", has);
  wrote("state/migrated", "6\n");
  migrate();
  expect(read(".gitignore")).toBe(has);
});
