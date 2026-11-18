import { afterAll, test } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

import { until } from "../hub/until.ts";
import { cloudflare } from "./cloudflare.ts";
import { folder, removeSandbox } from "./hex.ts";
import type { Folder } from "./hex.ts";
import { telegram } from "./telegram.ts";

type Chat = ReturnType<typeof telegram>;

type Store = ReturnType<typeof cloudflare>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A scenario's whole time limit, for a drill that hangs: a scenario that takes half a minute alone has taken three on a busy server.
const HANGS = 600_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What one wait gets beyond the machine's own slowness: hex's longest wait of its own on the way to an answer, a store it asks again within half a minute (hub/store/remote.ts), twice over. The longest wait of a healthy run on a server at load 60 was 33 seconds, with 16 to start.
const HEX_WAITS = 60_000;

const answer = (words: string) => `answer to: ${words}`;

const kept = (store: Store, key: string) =>
  Number(store.rows("select count(*) as n from messages where key = ?", key)[0]?.n);

const sent = (store: Store, words: string) =>
  Number(
    store.rows(
      `select count(*) as n from messages where "from" = 'telegram' and author = 'hex' and body = ?`,
      answer(words),
    )[0]?.n,
  );

const takerOf = (store: Store, key: string) =>
  store.rows("select taken_by from messages where key = ?", key)[0]?.taken_by;

function insist(holds: boolean, otherwise: string) {
  if (!holds) {
    throw new Error(otherwise);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One thing that happened to hex, played against hex whole: a failure says what didn't happen, then how each hub's log ends and what its sessions printed.
function scenario(name: string, play: (drill: Drill) => Promise<void>) {
  test.concurrent(
    name,
    async () => {
      const drill = drillFor();
      let hung: ReturnType<typeof setTimeout> | undefined;

      const hangs = new Promise<never>((_resolve, reject) => {
        hung = setTimeout(() => {
          reject(new Error(drill.waiting()));
        }, HANGS);
      });

      try {
        await Promise.race([play(drill), hangs]);
        drill.sound();
      } catch (error) {
        throw new Error(drill.failure(error instanceof Error ? error : new Error(String(error))), {
          cause: error,
        });
      } finally {
        clearTimeout(hung);
        await drill.end();
      }
    },
    HANGS + 60_000,
  );
}

type Drill = ReturnType<typeof drillFor>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The end of a log with each line once, where it last stood, and how often it came: an outage repeats one line for as long as it lasts.
function ending(log: string, lines: number) {
  const times = new Map<string, number>();

  for (const line of log.trimEnd().split("\n")) {
    const before = times.get(line) ?? 0;
    times.delete(line);
    times.set(line, before + 1);
  }

  return [...times]
    .slice(-lines)
    .map(([line, came]) => (came > 1 ? `${line} (${came} times)` : line))
    .join("\n");
}

function drillFor() {
  let waitingFor = "";
  let within = HANGS;
  const folders: Folder[] = [];
  const outside: { stop: () => Promise<void> }[] = [];

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A hook that fails in a session doesn't stop the session, and a reply the tool calls failed may have reached the owner all the same, so hex can go on with either: the drill fails on the first, whatever it was waiting for.
  const sound = () => {
    for (const each of folders) {
      insist(
        each.faults() === "",
        `a session on machine ${basename(each.dir)} was failed by hex:\n${each.faults()}`,
      );
    }
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A wait ends as failed well before the scenario's limit: after hex's own waits and four times what this hex took to start, which is how slow the machine is now.
  const soon = async <T>(what: string, check: () => T | Promise<T>) => {
    waitingFor = what;
    const began = Date.now();

    const value = await until(() => {
      sound();
      insist(
        Date.now() - began < within,
        `${what}: it hadn't happened after ${Math.round(within / 1000)} seconds`,
      );

      return check();
    });

    waitingFor = "";

    return value;
  };

  const step = async <T>(what: string, happening: Promise<T>) =>
    (await soon(what, async () => [await happening]))[0];

  const machine = async (name: string, chat: Chat, store: Store) => {
    const hex = await folder(name, { telegramUrl: chat.url, storeUrl: store.url });
    folders.push(hex);

    return hex;
  };

  const answered = async (chat: Chat, words: string) => {
    await soon(`the answer to "${words}" reaching Telegram`, () => chat.heard(answer(words)) > 0);
  };

  return {
    sound,
    soon,
    step,
    machine,
    answered,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A new hex folder on its own store and Telegram, running, with General's session connected.
    running: async () => {
      const chat = telegram();
      const store = cloudflare();
      outside.push(chat, store);
      const hex = await machine("a", chat, store);
      await hex.moveInto();
      const run = hex.start();
      const started = Date.now();
      await soon("hex starting, until General's session connects", hex.connected);
      within = Math.min(HANGS, HEX_WAITS + 4 * (Date.now() - started));

      return { chat, store, hex, run };
    },
    talk: async (chat: Chat, store: Store, words: string) => {
      const key = chat.say(words);
      await answered(chat, words);
      await soon(
        `the store keeping "${words}" and its answer`,
        () => kept(store, key) > 0 && sent(store, words) > 0,
      );

      return key;
    },
    waiting: () => (waitingFor === "" ? "the drill hung" : `${waitingFor}: it never happened`),
    failure: (error: Error) =>
      [
        error.message,
        ...folders.flatMap((each) => [
          `machine ${basename(each.dir)}'s hub log ends:\n${ending(each.log(), 40)}`,
          ...each
            .sessionLogs()
            .filter(({ log }) => log.trim() !== "")
            .map(
              ({ name, log }) =>
                `machine ${basename(each.dir)}'s session "${name}" printed:\n${ending(log, 10)}`,
            ),
        ]),
      ].join("\n\n"),
    end: async () => {
      await Promise.all(
        [...folders, ...outside].map(async (each) => {
          await each.stop();
        }),
      );
    },
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The owner's message and hex's answer to it each reached Telegram, and the store, once.
function once(chat: Chat, store: Store, key: string, words: string) {
  const told = chat.heard(answer(words));
  insist(told === 1, `the answer to "${words}" reached Telegram ${told} times, not once`);
  insist(
    kept(store, key) === 1,
    `the store holds the owner's "${words}" ${kept(store, key)} times, not once`,
  );
  insist(
    sent(store, words) === 1,
    `the store holds the answer to "${words}" ${sent(store, words)} times, not once`,
  );
}

afterAll(removeSandbox);

scenario(
  "the owner's message starts a session, whose answer reaches Telegram, and the store holds both",
  async ({ running, talk }) => {
    const { chat, store } = await running();
    const key = await talk(chat, store, "hello hex");
    once(chat, store, key, "hello hex");
  },
);

scenario(
  "a hub killed while a session holds a message: the next hub starts, and the answer arrives once",
  async ({ running, soon, answered, talk }) => {
    const { chat, store, hex } = await running();
    hex.hold(true);
    const key = chat.say("kill test");
    const taker = await soon('the session taking "kill test"', () => takerOf(store, key));
    const channel = () => hex.sessions().find(({ sessionId }) => sessionId === taker)?.channel;
    const before = channel();
    const killed = await hex.hub();
    process.kill(killed, "SIGKILL");
    await soon(
      "the run loop starting the next hub",
      async () => ![0, killed].includes(await hex.hub()),
    );
    await soon(
      'the session holding "kill test" connecting to the next hub',
      () => channel() !== before,
    );
    hex.hold(false);
    await answered(chat, "kill test");
    await talk(chat, store, "after the kill");
    once(chat, store, key, "kill test");
  },
);

scenario(
  "a session killed while it holds a message: the thread's next session answers it, once",
  async ({ running, soon, answered, talk }) => {
    const { chat, store, hex } = await running();
    hex.hold(true);
    const key = chat.say("crash test");
    const taker = await soon('the session taking "crash test"', () => takerOf(store, key));
    const pid = hex.sessions().find(({ sessionId }) => sessionId === taker)?.pid ?? 0;
    process.kill(pid, "SIGKILL");
    hex.hold(false);
    await answered(chat, "crash test");
    await talk(chat, store, "after the crash");
    once(chat, store, key, "crash test");
  },
);

scenario(
  "hex restart between two messages: the second is answered too",
  async ({ running, talk }) => {
    const { chat, store, hex } = await running();
    await talk(chat, store, "before the restart");
    await hex.bin("restart");
    const key = await talk(chat, store, "after the restart");
    once(chat, store, key, "after the restart");
  },
);

scenario(
  "the store stops answering as a message's session starts, then comes back: the session is given the message all the same, and nothing is lost or doubled",
  async ({ running, soon, answered, talk }) => {
    const { chat, store, hex } = await running();
    hex.hold(true, "channel");
    const first = chat.say("as the outage begins");
    await soon('the store keeping "as the outage begins"', () => kept(store, first) > 0);

    const { sessionId } = await soon("a session starting for it, its channel held", () =>
      hex.sessions().find(({ channel }) => channel === ""),
    );

    await store.down();
    hex.hold(false, "channel");

    await soon("that session connecting while the store doesn't answer", () =>
      hex.sessions().some((each) => each.sessionId === sessionId && each.channel !== ""),
    );

    await answered(chat, "as the outage begins");
    const key = chat.say("during the outage");
    await answered(chat, "during the outage");
    insist(
      existsSync(join(hex.dir, "state", "store.down")),
      "hex answered without finding its store down",
    );
    store.up();
    await soon(
      'the store keeping both answers and "during the outage", and the session that took the first, once it\'s back',
      () =>
        kept(store, key) > 0 &&
        sent(store, "as the outage begins") > 0 &&
        sent(store, "during the outage") > 0 &&
        takerOf(store, first),
    );
    await talk(chat, store, "after the outage");
    once(chat, store, first, "as the outage begins");
    once(chat, store, key, "during the outage");
  },
);

scenario(
  "a session killed while the store is silent: the thread's next session answers what comes meanwhile, and what the dead one held once the store is back",
  async ({ running, soon, answered, talk }) => {
    const { chat, store, hex } = await running();
    hex.hold(true);
    const held = chat.say("held as the store goes silent");

    const taker = await soon('the session taking "held as the store goes silent"', () =>
      takerOf(store, held),
    );

    const pid = hex.sessions().find(({ sessionId }) => sessionId === taker)?.pid ?? 0;
    store.silent();
    process.kill(pid, "SIGKILL");
    hex.hold(false);
    const meanwhile = chat.say("while the store is silent");
    await answered(chat, "while the store is silent");
    store.up();
    await answered(chat, "held as the store goes silent");
    await talk(chat, store, "after the store is back");
    once(chat, store, held, "held as the store goes silent");
    once(chat, store, meanwhile, "while the store is silent");
  },
);

scenario(
  "another machine takes hex over: the first stops as one that lost hex, stays stopped, and the second answers",
  async ({ running, machine, soon, step, talk }) => {
    const { chat, store, hex: first, run } = await running();
    await talk(chat, store, "before the move");
    const second = await machine("b", chat, store);
    copyFileSync(join(first.dir, "state", "store.json"), join(second.dir, "state", "store.json"));
    second.start();
    await soon("the second machine's General connecting", second.connected);
    const key = await talk(chat, store, "after the move");
    insist(
      (await step("the first machine's hex stopping", run.exited)) === 3,
      "the first machine's hex didn't stop as one that lost hex",
    );
    insist(
      existsSync(join(first.dir, "state", "lost")),
      "the first machine's hex left no word that it lost hex",
    );
    insist(
      (await step("hex started again on the first machine stopping", first.start().exited)) === 3,
      "hex started again on the machine that lost it",
    );
    const taker = takerOf(store, key);
    insist(
      second.sessions().some(({ sessionId }) => sessionId === taker),
      `"after the move" was taken by ${String(taker)}, not by a session of the second machine`,
    );
    await talk(chat, store, "later on the second machine");
    once(chat, store, key, "after the move");
  },
);
