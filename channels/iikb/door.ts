import { mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

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

// WARNING: iikb gives up on a read after 40s on Android and 60s on iOS, and the hub holds one 25s for a change.
const HELD_FOR_THE_HUB = 30_000;

const chatOf = (request: Request, url: URL) =>
  `${request.headers.get("authorization") ?? ""} ${url.pathname}`;

export function open(state: string, port: number, heldForTheHub = HELD_FOR_THE_HUB) {
  const sockets = socketsIn(state);
  let arrival = Promise.withResolvers<undefined>();

  const last = new Map<string, { said: ArrayBuffer; headers: Headers }>();

  async function fromHub(request: Request, url: URL, left: AbortSignal): Promise<Response> {
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
          signal: left,
        });

        const said = await answered.arrayBuffer();

        if (
          request.method === "GET" &&
          answered.ok &&
          answered.headers.get("content-type")?.includes("json") === true
        ) {
          last.set(chatOf(request, url), { said, headers: answered.headers });
        }

        return new Response(said.byteLength > 0 ? said : null, answered);
      } catch (error) {
        if (left.aborted) {
          throw error;
        }

        await next;
        url.searchParams.delete("after");
      }
    }
  }

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const known = url.searchParams.has("after") ? last.get(chatOf(request, url)) : undefined;
    const left = new AbortController();

    if (known === undefined) {
      return await fromHub(request, url, left.signal);
    }

    const again = Promise.withResolvers<Response>();

    const held = setTimeout(() => {
      again.resolve(new Response(known.said, { headers: known.headers }));
    }, heldForTheHub);

    try {
      return await Promise.race([fromHub(request, url, left.signal), again.promise]);
    } finally {
      clearTimeout(held);
      left.abort();
    }
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: answer });

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
