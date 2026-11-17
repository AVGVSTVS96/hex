#!/usr/bin/env bun
import { mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

import { CLAUDE, running } from "../hub/running.ts";
import type { Session } from "../hub/running.ts";
import { open, stateDir } from "../hub/store.ts";

const store = open(stateDir());
const sessions = join(CLAUDE, "sessions");
const settle = Number(process.env.HEX_QUIET_MS ?? 10_000);
const updateAskers = join(stateDir(), "update-askers");

const stamped = (at?: string): at is string => at !== undefined && at !== "";

const sessionsAskingForTheUpdateWithTheirAskTime = () => {
  try {
    return readFileSync(updateAskers, "utf-8")
      .split("\n")
      .map((line) => (line.split(" ")[0] ?? "").split("@"));
  } catch {
    return [];
  }
};

const turnEndedSinceClaudeCodeLastCalledItBusy = (session: Session) =>
  stamped(session.ended) && Date.parse(session.ended) >= (session.updated ?? Infinity);

mkdirSync(sessions, { recursive: true });

async function midTurn() {
  const asking = sessionsAskingForTheUpdateWithTheirAskTime();

  const turnWaitingOnTheUpdateItAskedFor = (session: Session) =>
    asking.some(
      ([id, at]) =>
        id === session.id &&
        (stamped(session.began) ? Date.parse(session.began) : (session.updated ?? Infinity)) <=
          Number(at),
    );

  return (await running(store))
    .values()
    .filter(
      (session) =>
        (session.kind === "bg" || session.beside !== undefined) &&
        session.status === "busy" &&
        !turnEndedSinceClaudeCodeLastCalledItBusy(session) &&
        !turnWaitingOnTheUpdateItAskedFor(session),
    )
    .map((session) => session.name ?? session.id)
    .toArray()
    .toSorted()
    .join(", ");
}

await new Promise<void>((resolve) => {
  let told = "";
  let timer: Timer | undefined;
  let queue = Promise.resolve();

  const check = async () => {
    const now = await midTurn();

    if (now !== "" && now !== told) {
      console.log(`waiting on: ${now}`);
    }

    told = now;

    if (now === "") {
      timer ??= setTimeout(() => {
        timer = undefined;
        queue = queue.then(settled);
      }, settle);
    } else {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const settled = async () => {
    if ((await midTurn()) === "") {
      resolve();
    } else {
      await check();
    }
  };

  const look = () => {
    queue = queue.then(check);
  };

  watch(sessions, look);
  watch(stateDir(), (_, file) => {
    if (file === "update-askers") {
      look();
    }
  });
  store.watch(look);
  look();
});

process.exit(0);
