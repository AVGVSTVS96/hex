import { DurableObject } from "cloudflare:workers";
import type { Namespace } from "cloudflare:workers";

import { recordsIn } from "./storage.ts";
import type { Reply } from "./wire.ts";

type Env = { STORE: Namespace; KEY?: string; VERSION?: string };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A Worker's address is public, so the key is long enough that guessing it is hopeless.
const SHORTEST_KEY = 32;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

type Version = { version: string | null; migrations: number | null };

const json = (body: Reply | Version, status = 200) => Response.json(body, { status });
const bytes = new TextEncoder();

const digest = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.encode(text)));

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Compares digests, so how long a refusal takes tells nothing of the key.
async function same(given: string, key: string) {
  const [a, b] = await Promise.all([digest(given), digest(key)]);

  return a.every((byte, at) => byte === b[at]);
}

// hex's records in one Durable Object: Cloudflare runs exactly one of it and answers a write only once machines in other buildings have it (https://blog.cloudflare.com/sqlite-in-durable-objects/), so no machine of the owner's holds them and a move between machines copies nothing. The store's own code runs here (store/storage.ts), each call one transaction, and every socket watching is told of each write. A socket's ping is answered without waking the object: https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation-api
export class Records extends DurableObject<Env> {
  private records: ReturnType<typeof recordsIn> | undefined;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname.split("/").slice(2).join("/");

    if (route === "watch") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);

      // SAFETY: Cloudflare's Response takes the client's end of the pair, which the web's ResponseInit has no place for: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }

    try {
      this.records ??= recordsIn(this.ctx.storage);
    } catch (error) {
      return json(
        {
          error: `hex's store can't open its records: ${error instanceof Error ? error.message : String(error)}`,
        },
        503,
      );
    }

    const { records } = this;

    try {
      if (route === "version") {
        return json({ version: this.env.VERSION ?? null, migrations: records.migrations() });
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // The body is read first, so the tenure is checked and the call answered in one stretch nothing else runs in.
      const body = await request.text();
      const tenure = request.headers.get("hex-tenure");
      const lost = records.lostTo(tenure === null ? undefined : Number(tenure));

      if (lost !== undefined) {
        return json({ error: lost }, 409);
      }

      if (route === "call") {
        const { reply, wrote } = records.call(body);

        if (wrote) {
          for (const socket of this.ctx.getWebSockets()) {
            try {
              socket.send(".");
            } catch {
              socket.close();
            }
          }
        }

        return json(reply);
      }

      if (route === "sql") {
        return json({ value: records.read(body) });
      }

      if (route.startsWith("move/")) {
        return json({ value: records.moved(route.slice("move/".length), body) });
      }

      return json({ error: `hex's store has no /${route}` }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.KEY === undefined || env.KEY.length < SHORTEST_KEY) {
      return json(
        {
          error: `hex's store has no key yet, so it answers no one: give its Worker a KEY secret of at least ${SHORTEST_KEY} characters`,
        },
        503,
      );
    }

    if (!(await same(request.headers.get("authorization") ?? "", `Bearer ${env.KEY}`))) {
      return json({ error: "hex's store takes only its owner's key" }, 401);
    }

    const [, name = ""] = new URL(request.url).pathname.split("/");

    if (!NAME.test(name)) {
      return json({ error: "hex's store answers at /<the object's name>/<route>" }, 404);
    }

    return await env.STORE.get(env.STORE.idFromName(name)).fetch(request);
  },
};
