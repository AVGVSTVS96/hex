import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dispatch, engine, startHub, hexDir } from "@hex/hub";
import type { Handlers } from "@hex/hub";

import { server, tools } from "./channel.ts";
import { cantAnswer, stopsHere, take, tool } from "./engine.ts";
import { serve } from "./serve.ts";

const filled = (value: string | undefined) => value !== undefined && value !== "";

const STATE = join(hexDir(), "state");
const THREAD = "voice";
const stateDir = process.env.VOICE_STATE_DIR ?? join(STATE, THREAD);

mkdirSync(stateDir, { recursive: true });

const handlers: Handlers<typeof tools> = {
  say: async (_, args) => await tool("say", args),
  note: async (_, args) => await tool("note", args),
  task: async (_, args) => await tool("task", args),
  running: async (_, args) => await tool("running", args),
  ask: async (_, args) => await tool("ask", args),
  answer: async (_, args) => await tool("answer", args),
  send: async (_, args) => await tool("send", args),
  style: async (_, args) => await tool("style", args),
  title: async (_, args) => await tool("title", args),
  phone: async (_, args) => await tool("phone", args),
  hang_up: async (_, args) => await tool("hang_up", args),
};

const eachCallGetsAFreshSessionThatReadsTheCallChat = () => true;

let onCall = false;

const hub = await startHub({
  stateDir,
  channel: process.env.VOICE_CHANNEL ?? "plugin:voice@hex",
  server,
  hexDir: hexDir(),
  fresh: eachCallGetsAFreshSessionThatReadsTheCallChat,
  limits: { capacity: 0 },
  ...(process.env.HEX_LAUNCHER !== undefined && { launcher: process.env.HEX_LAUNCHER }),
  call: dispatch(tools, handlers),
  state: (thread, busy, background) => {
    if (!busy && !background && !onCall) {
      void hub.stop(thread);
    }
  },
  failed: (_, reason, turn) => {
    const what = turn === true ? "its request to Claude failed" : "its session couldn't start";
    process.stderr.write(`voice hub: ${what}: ${reason}\n`);
    cantAnswer(`${what} (${reason.split("\n", 1)[0]}).`);
  },
});

serve(
  {
    deliver: async (content, meta) => {
      await hub.deliver(THREAD, THREAD, {
        content,
        meta,
        author: filled(meta.callee)
          ? "other"
          : filled(meta.delegation_id) || filled(meta.ended)
            ? "call"
            : "prompt",
      });
    },
    keep: async () => {
      onCall = true;
      await hub.keep(THREAD);
    },
    renew: () => {
      onCall = false;
      hub.hangUp(THREAD);
    },
    adrift: (away) => {
      hub.adrift(THREAD, away);
    },
    session: () => hub.session(THREAD),
    interrupt: () => hub.interrupt(THREAD),
  },
  STATE,
);

engine.take = take;

engine.stops = stopsHere;
