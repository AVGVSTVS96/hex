import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { clients, hexDir, open } from "@hex/hub";

import { APP, answer } from "./chats.ts";
import { arrived, socketsIn } from "./door.ts";

const store = open(join(hexDir(), "state"));
const { chats } = socketsIn(store.dir);

await clients.joined(APP);

try {
  mkdirSync(dirname(chats), { recursive: true });
  rmSync(chats, { force: true });

  const socket: Bun.Serve.Options<undefined> = {
    unix: chats,
    fetch: async (request) => await answer(store, request, process.env.IIKB_TOKEN),
  };

  // SAFETY: Bun takes idleTimeout for a socket as for a port, and without it ends a request held past 10 seconds; its types keep idleTimeout to ports.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- widens to the option Bun's socket server takes
  Bun.serve({ ...socket, idleTimeout: 60 } as typeof socket);
  arrived(store.dir);
} catch (error) {
  process.stderr.write(`iikb: can't listen at ${chats}: ${String(error)}\n`);
}
