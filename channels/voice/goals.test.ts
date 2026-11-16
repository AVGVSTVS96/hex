import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "@hex/hub";

import { Board } from "./board.ts";
import { everyOf, Goals } from "./goals.ts";
import { Questions } from "./questions.ts";

const home = mkdtempSync(join(tmpdir(), "voice-goals-"));
const hex = join(home, "hex");
const state = join(hex, "state");
const claude = join(home, "claude");

mkdirSync(join(state, "telegram"), { recursive: true });

mkdirSync(claude, { recursive: true });

const board = new Board(state, hex, claude);

afterAll(() => {
  board.close();
  rmSync(home, { recursive: true });
});

test("how often a watch runs reads as the owner would say it", () => {
  expect(everyOf({ cron: "0 9 * * *" })).toBe("every day at 9 AM");
  expect(everyOf({ cron: "30 13 * * *" })).toBe("every day at 1:30 PM");
  expect(everyOf({ cron: "0 10 * * 1" })).toBe("every Monday at 10 AM");
  expect(everyOf({ cron: "0 9 1,15 * *" })).toBe("on day 1 and 15 of the month at 9 AM");
  expect(everyOf({ cron: "30 */3 * * *" })).toBe("every 3 hours");
  expect(everyOf({ cron: "20 8-23 * * *" })).toBe("hourly, 8 AM to 11 PM");
  expect(everyOf({ cron: "40 8-22/2 * * *" })).toBe("every 2 hours, 8 AM to 10 PM");
  expect(everyOf({ cron: "*/5 * * * *" })).toBe("on a schedule");
  expect(everyOf({ at: "2026-12-06 09:00" }, "America/Los_Angeles")).toBe("once, Dec 6 at 9 AM");
});

test("a goal reached a month ago leaves the list but still opens by its id", () => {
  open(state).messages.deliver({
    key: "telegram:-1001234567890:9100",
    to: "-1001234567890:102",
    from: "telegram",
    author: "owner",
    body: "ship the release",
  });

  const task = open(state).tasks.create({
    title: "Ship the release",
    message: "telegram:-1001234567890:9100",
    owner: "-1001234567890:102",
    doneWhen: "the release is out",
  });

  open(state).tasks.edit(task.id, { status: "done", proof: "shipped as 1.0" });

  const db = new Database(join(state, "hex.db"));
  db.query("update tasks set closed = ? where n = ?").run(
    new Date(Date.now() - 30 * 86_400_000).toISOString(),
    Number(task.id.slice(2)),
  );
  db.close();

  const questions = new Questions(state, {
    t3Database: "/nonexistent",
    t3Home: "/nonexistent",
    check: () => {},
  });

  const goals = new Goals(state, hex, board, questions);
  goals.refresh();

  expect(goals.view.goals.map((goal) => goal.id)).not.toContain(task.id);
  expect(goals.goal(task.id)).toMatchObject({
    id: task.id,
    title: "Ship the release",
    state: "done",
  });
  expect(goals.goal("t-999999")).toBeUndefined();

  goals.close();
  questions.close();
});
