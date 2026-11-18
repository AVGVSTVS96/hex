import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DurableObject, Namespace } from "cloudflare:workers";

import { objectStorage } from "./fake.ts";
import type { Storage } from "./storage.ts";

type State = ConstructorParameters<typeof DurableObject>[0];

type Env = { KEY?: string; VERSION?: string; STORE: Namespace };

export const KEY = "a key long enough that nobody guesses it";

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The runtime's own pair of a ping and its answer, which the object only hands to its context.
Object.assign(globalThis, { WebSocketRequestResponsePair: Array });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store's Worker and its object, loaded outside Cloudflare's runtime: for a test's own stand-in of it (served, below, and the drill's).
export const { default: worker, Records } = await import("./object.ts");

type Between = (
  route: string,
  answer: () => Promise<Response>,
  request: Request,
) => Promise<Response>;

export function served(storage = objectStorage(), env?: Omit<Env, "STORE">, between?: Between) {
  const objects = new Map<string, InstanceType<typeof Records>>();
  const storages = new Map<string, Storage>([["hex", storage]]);

  const named: Env = {
    ...(env ?? { KEY }),
    STORE: {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => ({
        fetch: async (request) => {
          const name = id.toString();

          const records =
            objects.get(name) ??
            new Records(
              {
                storage:
                  storages.get(name) ?? storages.set(name, objectStorage()).get(name) ?? storage,
                acceptWebSocket: (): void => undefined,
                getWebSockets: () => [],
                setWebSocketAutoResponse: (): void => undefined,
              },
              named,
            );

          objects.set(name, records);
          const route = new URL(request.url).pathname.split("/").slice(2).join("/");
          const answer = async () => await records.fetch(request);

          return between === undefined ? await answer() : await between(route, answer, request);
        },
      }),
    },
  };

  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, named) });

  return {
    storage,
    storageOf: (name: string) => storages.get(name),
    url: server.url.origin,
    stop: async () => {
      await server.stop(true);
    },
  };
}

export function pointedAt(at: string, url: string, name = "hex") {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "store.json"), JSON.stringify({ url, name, key: KEY }));
}
