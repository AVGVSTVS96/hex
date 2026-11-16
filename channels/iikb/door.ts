import { mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The keyboard has no clock to try a refused read again on, and the hub restarts many times a day. So bin/hex keeps this door on the port for as long as hex runs on the machine: it hands each request to the hub at `chats`, and one that finds no hub, or whose hub goes before answering, waits here until the next hub says it's up at `door`. A hub gets a request once, so one it can't answer never goes round. This file imports nothing of hex's, since bin/hex replaces a running door only when this file changes.
export const socketsIn = (state: string) => ({
  chats: join(state, "iikb", "chats.sock"),
  door: join(state, "iikb", "door.sock"),
});

const ignore = (): undefined => undefined;

export function arrived(state: string) {
  const door = connect(socketsIn(state).door, () => {
    door.end();
  }).on("error", ignore);
}

export function open(state: string, port: number) {
  const sockets = socketsIn(state);
  let arrival = Promise.withResolvers<undefined>();

  mkdirSync(dirname(sockets.door), { recursive: true });
  rmSync(sockets.door, { force: true });

  const bell = Bun.listen({
    unix: sockets.door,
    socket: {
      open() {
        const { resolve } = arrival;
        arrival = Promise.withResolvers();
        resolve(undefined);
      },
      data: ignore,
    },
  });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A request that waited for a hub goes to it without `after`: the hub that held it to that version is gone, and the keyboard has waited long enough, so the next hub answers with the chat as it is now.
  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sent = request.body === null ? null : await request.arrayBuffer();

    for (;;) {
      const next = arrival.promise;

      try {
        const answered = await fetch(`http://hub${url.pathname}${url.search}`, {
          unix: sockets.chats,
          method: request.method,
          headers: request.headers,
          body: sent,
          keepalive: false,
        });

        const said = await answered.arrayBuffer();

        return new Response(said.byteLength > 0 ? said : null, answered);
      } catch {
        await next;
        url.searchParams.delete("after");
      }
    }
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: answer });
  const stop = server.stop.bind(server);

  server.stop = async (closeActiveConnections) => {
    bell.stop(true);
    await stop(closeActiveConnections);
  };

  return server;
}

if (import.meta.main) {
  open(process.argv[2] ?? "", Number(process.env.IIKB_PORT ?? "2593"));
}
