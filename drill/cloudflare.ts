import type { Namespace } from "cloudflare:workers";

import { objectStorage } from "../hub/store/fake.ts";
import { Records, worker } from "../hub/store/object.testing.ts";

type Env = { KEY: string; VERSION: string; STORE: Namespace };

export const KEY = "drill-store-key-long-enough-for-the-worker";

export function cloudflare() {
  const storage = objectStorage();
  const sockets = new Set<Bun.ServerWebSocket>();

  const env: Env = {
    KEY,
    VERSION: "drill",
    STORE: {
      idFromName: (name) => ({ toString: () => name }),
      get: () => ({ fetch: async (request) => await records.fetch(request) }),
    },
  };

  const records = new Records(
    {
      storage,
      // oxlint-disable-next-line eslint/no-empty-function -- the sockets are accepted around the object, in Bun's server
      acceptWebSocket: () => {},
      getWebSockets: () => [...sockets],
      // oxlint-disable-next-line eslint/no-empty-function -- the server answers a ping itself, as the runtime would
      setWebSocketAutoResponse: () => {},
    },
    env,
  );

  const serve = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      fetch: async (request, server) => {
        if (
          new URL(request.url).pathname.endsWith("/watch") &&
          request.headers.get("authorization") === `Bearer ${KEY}`
        ) {
          return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
        }

        return await worker.fetch(request, env);
      },
      websocket: {
        open: (socket) => {
          sockets.add(socket);
        },
        message: (socket, data) => {
          if (String(data) === "ping") {
            socket.send("pong");
          }
        },
        close: (socket) => {
          sockets.delete(socket);
        },
      },
    });

  let server: ReturnType<typeof serve> | undefined = serve(0);
  const port = server.port ?? 0;

  return {
    url: `http://127.0.0.1:${port}`,
    down: async () => {
      await server?.stop(true);
      server = undefined;
    },
    up: () => {
      server ??= serve(port);
    },
    rows: (query: string, ...bound: unknown[]) => storage.sql.exec(query, ...bound).toArray(),
    stop: async () => {
      await server?.stop(true);
    },
  };
}
