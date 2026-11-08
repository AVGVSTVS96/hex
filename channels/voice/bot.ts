import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dispatch, engine, startHub, hexDir } from "@hex/hub";
import type { Handlers } from "@hex/hub";

import { server, tools } from "./channel.ts";
import { serve, take, tool } from "./server.ts";

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
  title: async (_, args) => await tool("title", args),
  phone: async (_, args) => await tool("phone", args),
  hang_up: async (_, args) => await tool("hang_up", args),
};

const eachCallGetsAFreshSessionThatReadsTheCallChat = () => true;

const hub = startHub({
  stateDir,
  channel: process.env.VOICE_CHANNEL ?? "plugin:voice@hex",
  server,
  main: THREAD,
  mainName: THREAD,
  hexDir: hexDir(),
  fresh: eachCallGetsAFreshSessionThatReadsTheCallChat,
  limits: { capacity: 0 },
  ...(process.env.HEX_LAUNCHER !== undefined && { launcher: process.env.HEX_LAUNCHER }),
  call: dispatch(tools, handlers),
  // oxlint-disable-next-line eslint/no-empty-function -- the voice hub shows no session status anywhere
  state: () => {},
  failed: (_, reason) => {
    process.stderr.write(`voice hub: the voice session couldn't start: ${reason}\n`);
  },
});

serve(
  {
    deliver: (content, meta) => {
      hub.deliver(THREAD, THREAD, {
        content,
        meta,
        author: filled(meta.callee)
          ? "other"
          : filled(meta.delegation_id) || filled(meta.ended)
            ? "call"
            : "prompt",
      });
    },
    keep: () => hub.keep(THREAD),
    renew: () => {
      hub.renew(THREAD);
    },
    renewal: () => hub.renewal(THREAD),
    session: () => hub.session(THREAD),
  },
  STATE,
);

engine.take = take;
