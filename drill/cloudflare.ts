import { mock } from "bun:test";
import { join } from "node:path";

import type { DurableObject, Namespace } from "cloudflare:workers";

import { objectStorage } from "../hub/store/fake.ts";

type State = ConstructorParameters<typeof DurableObject>[0];

type Env = { KEY: string; VERSION: string; STORE: Namespace };

void mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: State;
    readonly env: Env;

    constructor(ctx: State, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

Object.assign(globalThis, { WebSocketRequestResponsePair: Array });

const { default: worker, Records } = await import("../hub/store/object.ts");

export const KEY = "drill-store-key-long-enough-for-the-worker";

// Cloudflare running hex's store (hub/store/object.ts) as one Durable Object behind its Worker, on SQLite as the runtime keeps it: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
// The runtime answers a watching socket's ping itself, and the object tells each socket of every write; both happen here, around the object's code, since Bun has no WebSocketPair: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
export function cloudflare(dir: string) {
  const storage = objectStorage(join(dir, "object.db"));
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
      // SAFETY: the object only sends to and closes the sockets it's given, which Bun's server sockets do.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Bun's server socket shares only send and close with the web's
      getWebSockets: () => [...sockets] as unknown as WebSocket[],
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
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // An outage: the store's address refuses every connection, cutting those open, its watching sockets among them.
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
