import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Author } from "../../hub/store.ts";
import { open } from "../../hub/store.ts";

const BIN = join(import.meta.dir, "../../bin");
const SESSION = "b7e2c5a9-0000-4000-8000-000000000000";
const LIMIT = 10_000;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "compacted-"));
  mkdirSync(join(home, ".hex/bin"), { recursive: true });
  mkdirSync(join(home, ".hex/vendor"));

  for (const script of ["compacted", "hex"]) {
    copyFileSync(join(BIN, script), join(home, ".hex/bin", script));
  }

  symlinkSync(join(import.meta.dir, "../../hub"), join(home, ".hex/hub"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function kept(thread: string, turns: [Author, string][]) {
  const store = open(join(home, "state"));

  for (const [i, [author, body]] of turns.entries()) {
    store.messages.deliver(
      { key: `telegram:${i}`, to: thread, from: "telegram", author, body },
      SESSION,
    );
    store.db
      .query("update messages set at = ? where key = ?")
      .run(new Date(Date.UTC(2026, 9, 6, 16, i)).toISOString(), `telegram:${i}`);
  }
}

function hook(env: Record<string, string> = {}, source = "compact") {
  const run = Bun.spawnSync([join(home, ".hex/bin/compacted")], {
    cwd: home,
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, source })),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: home,
      MEMORY_DIR: join(home, "memory"),
      TMPDIR: home,
      TZ: "UTC",
      HEX_THREAD: "",
      HEX_MAIN: "",
      HEX_STORE: join(home, "state"),
      ...env,
    },
  });

  expect(run.exitCode).toBe(0);
  const out = run.stdout.toString();
  expect(out.trim().length).toBeLessThanOrEqual(LIMIT);

  return out;
}

test("brings back the thread's whole conversation when it fits", () => {
  kept("42", [
    ["owner", "hi"],
    ["hex", "hey"],
    ["owner", "what is up"],
  ]);
  kept("43", [["owner", "another thread"]]);
  const out = hook({ HEX_THREAD: "42" });
  expect(out).toContain("the conversation's newest messages");
  expect(out).toContain("## owner · telegram · 42 · 2026-10-06 16:00 · [telegram:0]\n\nhi");
  expect(out).toContain("## hex · telegram · 42 · 2026-10-06 16:01 · [telegram:1]\n\nhey");
  expect(out).not.toContain("another thread");
});

test("brings back the last whole turns of a long conversation, and points to the earlier ones", () => {
  kept(
    SESSION,
    Array.from({ length: 40 }, (_, i): [Author, string] => [
      i % 2 ? "hex" : "owner",
      `turn ${i} ${"y".repeat(600)}`,
    ]),
  );
  const out = hook();
  expect(out).toContain(
    `\`${join(home, ".hex/bin")}/hex log -- '${SESSION}'\` has any before them`,
  );
  expect(out.split("\n\n").slice(1).join("\n\n")).toMatch(/^## (owner|hex) · /u);
  expect(out).toContain("turn 39");
  expect(out).not.toContain("turn 20 ");
});

test("brings back the end of a message too long for a hook on its own", () => {
  kept(SESSION, [["owner", `start ${"z".repeat(20_000)} the end`]]);
  const out = hook();
  expect(out).toEndWith("the end\n");
  expect(out).toContain("## owner · telegram · ");
  expect(out).not.toContain("start");
});

test("a new session taking over a thread gets the session it continues from, and nothing else", () => {
  kept("42", [
    ["owner", "ship it"],
    ["hex", "shipped"],
  ]);
  const transcript = join(home, "0d1e2f3a-0000-4000-8000-000000000000.jsonl");
  writeFileSync(transcript, "{}\n");
  const out = hook({ HEX_THREAD: "42", HEX_HANDOFF: transcript }, "startup");
  expect(out).toBe(
    `You're continuing this thread from session 0d1e2f3a-0000-4000-8000-000000000000: ${transcript}\n`,
  );
});

test("a new session taking over from one whose transcript isn't on this machine gets where the thread's messages are", () => {
  kept("42", [["owner", "ship it"]]);
  const transcript = join(home, "0d1e2f3a-0000-4000-8000-000000000000.jsonl");
  const out = hook({ HEX_THREAD: "42", HEX_HANDOFF: transcript }, "startup");
  expect(out).toBe(
    `You're continuing this thread from session 0d1e2f3a-0000-4000-8000-000000000000, whose transcript isn't on this machine: \`${join(home, ".hex/bin")}/hex log -- '42'\` has its messages.\n`,
  );
});

test("a session that starts without taking over, or resumes, gets nothing from it", () => {
  kept("42", [["owner", "hi"]]);
  expect(hook({ HEX_THREAD: "42" }, "startup")).toBe("");
  expect(hook({ HEX_THREAD: "42", HEX_HANDOFF: "/old.jsonl" }, "resume")).toBe("");
});
