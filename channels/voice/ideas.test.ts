import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "@hex/hub";
import { z } from "zod";

import { Ideas } from "./ideas.ts";

// SAFETY: an asymmetric matcher stands in for any string inside toEqual.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bun-types declares every asymmetric matcher as any
const aString = expect.any(String) as string;

let hex: string;
let state: string;
let ideas: Ideas;

beforeEach(() => {
  hex = mkdtempSync(join(tmpdir(), "voice-ideas-"));
  state = join(hex, "state");
  mkdirSync(join(state, "voice"), { recursive: true });
  ideas = new Ideas(state);
});

afterEach(() => {
  ideas.close();
  rmSync(hex, { recursive: true, force: true });
});

async function idea(title: string, words: string) {
  const store = open(state);
  const key = `telegram:-100:${title.length}`;

  await store.threads.keep("telegram", { "-100:7": { name: "Kitchen remodel" } });

  await store.messages.deliver({
    key,
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: words,
    meta: { user: "owner" },
  });

  return (await store.tasks.create({ title, message: key, owner: "-100:7", status: "idea" })).id;
}

function checked(id: string, at: string, news: boolean, finding: string) {
  appendFileSync(
    join(state, "ideas.jsonl"),
    `${JSON.stringify({ at, schedule: "rail", idea: id, news, finding })}\n`,
  );
}

const schedules = () =>
  z
    .record(z.string(), z.json())
    .parse(JSON.parse(readFileSync(join(hex, "schedules.json"), "utf-8")));

test("an idea shows in the owner's words with its topic, and what hex found stays found until it's opened", async () => {
  const id = await idea(
    "A pot rail over the island",
    "what about a rail over the island for the pans",
  );

  checked(id, "2026-11-10T09:00:00.000Z", false, "Nothing cut to length yet.");
  checked(id, "2026-11-15T13:40:00.000Z", true, "Two makers cut brass to 90 cm.");

  expect(await ideas.list()).toEqual([
    {
      id,
      status: "idea",
      title: "A pot rail over the island",
      topic: "Kitchen remodel",
      thread: "telegram:-100:7",
      project: "",
      said: "what about a rail over the island for the pans",
      at: aString,
      looking: false,
      day: "",
      found: true,
      checks: [
        { at: "2026-11-15T13:40:00.000Z", news: true, finding: "Two makers cut brass to 90 cm." },
        { at: "2026-11-10T09:00:00.000Z", news: false, finding: "Nothing cut to length yet." },
      ],
    },
  ]);

  ideas.seen(id);
  expect((await ideas.list())[0]?.found).toBe(false);
});

test("stopping takes the idea's check out of schedules.json, leaving the rest as written, and looking again puts the same one back", async () => {
  const id = await idea("A pot rail over the island", "a rail for the pans");
  const rail = { cron: "0 10 * * 0", idea: id, prompt: "Who cuts brass rails to length?" };
  const heartbeat = { cron: "45 * * * *", prompt: "Hourly check", note: "kept as written" };
  writeFileSync(join(hex, "schedules.json"), JSON.stringify({ heartbeat, rail }));

  expect((await ideas.list())[0]).toMatchObject({ looking: true, day: "Sunday" });

  await ideas.stop(id);
  expect(schedules()).toEqual({ heartbeat });
  expect((await ideas.list())[0]).toMatchObject({ looking: false, day: "" });

  await ideas.look(id, 3);
  expect(schedules()).toEqual({ heartbeat, rail });
});

test("looking into an idea that never had a check gives it a weekly one on the day the app says", async () => {
  const id = await idea("A second bike for guests", "if a cheap one turns up");
  await ideas.look(id, 2);

  expect(schedules()).toEqual({
    [`idea-${id}`]: {
      cron: "0 9 * * 2",
      idea: id,
      prompt: "What's new on this idea: A second bike for guests",
    },
  });

  expect((await ideas.list())[0]).toMatchObject({ looking: true, day: "Tuesday" });
});

test("a started or dropped idea leaves the list but its page still reads, and keeping it brings it back", async () => {
  const id = await idea("Ask readers what they want more of", "maybe a short survey");

  expect(await ideas.status(id, "open")).toBe("idea");
  expect(await ideas.list()).toEqual([]);
  expect((await ideas.one(id))?.status).toBe("open");

  expect(await ideas.status(id, "idea")).toBe("open");
  await ideas.status(id, "dropped");
  expect(await ideas.list()).toEqual([]);

  await ideas.status(id, "idea");
  expect((await ideas.list()).map((each) => each.id)).toEqual([id]);
});
