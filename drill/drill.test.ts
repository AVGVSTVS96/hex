import { afterAll, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { until } from "../hub/until.ts";
import { cloudflare } from "./cloudflare.ts";
import { folder, place, removeSandbox } from "./hex.ts";
import type { Folder } from "./hex.ts";
import { telegram } from "./telegram.ts";

type Chat = ReturnType<typeof telegram>;

type Store = ReturnType<typeof cloudflare>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The one time limit, for a drill that hangs: every wait is on something hex does, however long a loaded machine takes to do it.
const HANGS = 240_000;

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
// One thing that happened to hex, played against hex whole: a failure says what didn't happen, then how each hub's log ends.
function scenario(name: string, play: (drill: Drill) => Promise<void>) {
  test.concurrent(
    name,
    async () => {
      const drill = drillFor();
      let hung: ReturnType<typeof setTimeout> | undefined;

      const hangs = new Promise<never>((_resolve, reject) => {
        hung = setTimeout(() => {
          reject(new Error("the drill hung"));
        }, HANGS);
      });

      try {
        await Promise.race([play(drill), hangs]);
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

function drillFor() {
  let waitingFor = "";
  const folders: Folder[] = [];
  const outside: { stop: () => Promise<void> }[] = [];

  const soon = async <T>(what: string, check: () => T | Promise<T>) => {
    waitingFor = what;
    const value = await until(check);
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
    soon,
    step,
    machine,
    answered,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A new hex folder on its own store and Telegram, running, with General's session connected.
    running: async () => {
      const chat = telegram();
      const store = cloudflare(place("cloudflare"));
      outside.push(chat, store);
      const hex = await machine("a", chat, store);
      await hex.moveInto();
      const run = hex.start();
      await soon("hex starting, until General's session connects", hex.connected);

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
    failure: (error: Error) =>
      [
        waitingFor === "" ? error.message : `${waitingFor}: it never happened`,
        ...folders.map(
          (each) =>
            `${each.dir}/state/hub.log ends:\n${each.log().split("\n").slice(-40).join("\n")}`,
        ),
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
    const channel = () => hex.sessions().find(({ session }) => session === taker)?.channel;
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
  "the store stops answering mid-conversation, then comes back: nothing is lost or doubled",
  async ({ running, soon, answered, talk }) => {
    const { chat, store, hex } = await running();
    await talk(chat, store, "before the outage");
    await store.down();
    const key = chat.say("during the outage");
    await answered(chat, "during the outage");
    insist(
      existsSync(join(hex.dir, "state", "store.down")),
      "hex answered without finding its store down",
    );
    store.up();
    await soon(
      'the store keeping "during the outage" and its answer, once it\'s back',
      () => kept(store, key) > 0 && sent(store, "during the outage") > 0,
    );
    await talk(chat, store, "after the outage");
    once(chat, store, key, "during the outage");
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
      second.sessions().some(({ session }) => session === taker),
      `"after the move" was taken by ${String(taker)}, not by a session of the second machine`,
    );
    await talk(chat, store, "later on the second machine");
    once(chat, store, key, "after the move");
  },
);

scenario(
  "a commit whose hub can't start: hex goes back to the last good one, says so, and still answers",
  async ({ running, soon, talk }) => {
    const { chat, store, hex } = await running();
    await talk(chat, store, "before the update");
    const good = await hex.git("rev-parse", "HEAD");
    const serve = join(hex.hex, "hub", "serve.ts");
    writeFileSync(
      serve,
      `throw new Error("this hub can't start");\n${readFileSync(serve, "utf-8")}`,
    );
    await hex.git("commit", "-qam", "a hub that can't start");
    await hex.bin("restart");
    await soon(
      "hex going back to the last good commit",
      async () => (await hex.git("rev-parse", "HEAD")) === good,
    );
    await soon(
      "General hearing that hex went back",
      () => chat.heard("couldn't start: its hub exited three times") > 0,
    );
    const key = await talk(chat, store, "after the rollback");
    once(chat, store, key, "after the rollback");
  },
);

scenario(
  "a .env line that fails stops hex, with General told why, instead of a hub that never starts",
  async ({ running, soon, step, talk }) => {
    const { chat, store, hex, run } = await running();
    await talk(chat, store, "before the edit");
    appendFileSync(join(hex.dir, ".env"), "this line fails\n");
    await hex.bin("restart");
    insist(
      (await step("hex stopping on the failing line", run.exited)) !== 0,
      "hex stopped as if nothing were wrong",
    );
    await soon("General hearing why hex can't start", () => chat.heard("fails as a command") > 0);
  },
);
