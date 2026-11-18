import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importLogs } from "./past.ts";
import { open } from "./store.ts";

test("every session's log comes in with one write, so an import stops whole or not at all", async () => {
  const home = mkdtempSync(join(tmpdir(), "past-"));
  mkdirSync(join(home, "log", "threads"), { recursive: true });

  for (const session of ["first-session", "second-session"]) {
    writeFileSync(
      join(home, "log", "threads", `2026-10-01-${session}.md`),
      `# 2026-10-01 · session ${session}\n\n## me · telegram · 2026-10-01 10:06\n\nfrom ${session}\n`,
    );
  }

  const store = open(join(home, "state"));
  const writes: number[] = [];

  const counted = {
    ...store,
    messages: {
      ...store.messages,
      past: async (rows: Parameters<typeof store.messages.past>[0]) => {
        writes.push(rows.length);

        return await store.messages.past(rows);
      },
    },
  };

  expect(await importLogs(counted, join(home, "log"), "America/Los_Angeles")).toBe(2);
  expect(writes).toEqual([2]);
  rmSync(home, { recursive: true, force: true });
});
