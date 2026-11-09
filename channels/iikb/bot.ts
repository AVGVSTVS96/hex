import { join } from "node:path";

import { hexDir, open } from "@hex/hub";

import { answer } from "./chats.ts";

const store = open(join(hexDir(), "state"));
const port = Number(process.env.IIKB_PORT ?? "2593");

try {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    fetch: async (request) => await answer(store, request, process.env.IIKB_TOKEN),
  });
} catch (error) {
  process.stderr.write(`iikb: can't listen on ${port}: ${String(error)}\n`);
}
