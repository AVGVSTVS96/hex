import { DurableObject } from "cloudflare:workers";
import type { Namespace } from "cloudflare:workers";

import { recordsIn } from "./storage.ts";
import type { Reply } from "./wire.ts";

type Env = { STORE: Namespace; KEY: string };

const json = (body: Reply, status = 200) => Response.json(body, { status });

// hex's records in one Durable Object: Cloudflare runs exactly one of it and answers a write only once machines in other buildings have it (https://blog.cloudflare.com/sqlite-in-durable-objects/), so no machine of the owner's holds them and a move between machines copies nothing. The store's own code runs here (store/storage.ts), each call one transaction, and every socket watching is told of each write.
export class Records extends DurableObject<Env> {
  private readonly records = recordsIn(this.ctx.storage);

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    try {
      if (pathname === "/watch") {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);

        // SAFETY: Cloudflare's Response takes the client's end of the pair, which the web's ResponseInit has no place for: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // The body is read first, so the tenure is checked and the call answered in one stretch nothing else runs in.
      const body = await request.text();
      const tenure = request.headers.get("hex-tenure");
      const lost = this.records.lostTo(tenure === null ? undefined : Number(tenure));

      if (lost !== undefined) {
        return json({ error: lost }, 409);
      }

      if (pathname === "/call") {
        const { reply, wrote } = this.records.call(body);

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

      if (pathname === "/sql") {
        return json({ value: this.records.read(body) });
      }

      if (pathname.startsWith("/move/")) {
        return json({ value: this.records.moved(pathname.slice("/move/".length), body) });
      }

      return json({ error: `hex's store has no ${pathname}` }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (request.headers.get("authorization") !== `Bearer ${env.KEY}`) {
      return json({ error: "hex's store takes only its owner's key" }, 401);
    }

    return env.STORE.get(env.STORE.idFromName("hex")).fetch(request);
  },
};
