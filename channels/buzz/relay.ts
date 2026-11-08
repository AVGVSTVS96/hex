import type { Filter } from "nostr-tools/filter";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Event } from "nostr-tools/pure";
import { z } from "zod";

type Template = { kind: number; content: string; tags: string[][]; created_at?: number };

export type Relay = {
  pubkey: string;
  publish: (event: Template) => Promise<Event>;
  subscribe: (filters: Filter[], onEvent: (event: Event) => void) => () => void;
  query: (filters: Filter[]) => Promise<Event[]>;
  close: () => void;
};

type Request = { message: unknown[]; events?: Event[]; done: (error?: string) => void };

export const nostrEvent = z.looseObject({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number(),
  kind: z.number(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

const frame = z.union([
  z.tuple([z.literal("AUTH"), z.string()], z.unknown()),
  z.tuple([z.literal("OK"), z.string(), z.boolean(), z.string().default("")], z.unknown()),
  z.tuple([z.literal("EVENT"), z.string(), nostrEvent], z.unknown()),
  z.tuple([z.literal("EOSE"), z.string()], z.unknown()),
  z.tuple([z.literal("CLOSED"), z.string(), z.string().default("")], z.unknown()),
  z.tuple([z.literal("NOTICE"), z.string()], z.unknown()),
]);

const handled = new Set(["AUTH", "OK", "EVENT", "EOSE", "CLOSED", "NOTICE"]);

const TIMEOUT = 20_000;
const PING = 30_000;
const OVERLAP = 60;

const now = () => Math.floor(Date.now() / 1000);

export function connectRelay({
  url,
  secretKey,
  authTag,
}: {
  url: string;
  secretKey: Uint8Array;
  authTag: string[];
}): Relay {
  const pubkey = getPublicKey(secretKey);

  const subs = new Map<
    string,
    { filters: Filter[]; onEvent: (event: Event) => void; stored?: Event[] }
  >();

  const seen = new Set<string>();
  const requests = new Map<string, Request>();
  let socket: Bun.WebSocket | undefined;
  let auth = "";
  let ready = false;
  let closed = false;
  let attempt = 0;
  let alive = 0;
  let answered = true;
  let next = 0;

  function send(message: unknown[]) {
    if (ready) {
      socket?.send(JSON.stringify(message));
    }
  }

  function sign(template: Template) {
    return finalizeEvent(
      { created_at: now(), ...template, tags: [...template.tags, authTag] },
      secretKey,
    );
  }

  function req(id: string, filters: Filter[], resumeFrom = 0) {
    const sub = subs.get(id);

    if (sub) {
      sub.stored = [];
    }

    send([
      "REQ",
      id,
      ...filters.map((filter) =>
        filter.since === undefined
          ? filter
          : { ...filter, since: Math.max(filter.since, resumeFrom) },
      ),
    ]);
  }

  function flush(id: string) {
    const sub = subs.get(id);
    const stored = sub?.stored;

    if (!stored) {
      return;
    }

    delete sub.stored;

    for (const each of stored.toSorted(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    )) {
      sub.onEvent(each);
    }
  }

  function open() {
    // SAFETY: Bun's global WebSocket is Bun.WebSocket, which has ping() and terminate().
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- lib.dom's WebSocket type is the wrong one under Bun
    const ws = new WebSocket(url) as unknown as Bun.WebSocket;
    socket = ws;
    ws.addEventListener("message", ({ data }) => {
      if (ready) {
        alive = now();
      }

      answered = true;

      try {
        read(String(data));
      } catch (error) {
        process.stderr.write(`buzz hub: dropped a bad frame from the relay: ${String(error)}\n`);
      }
    });
    ws.addEventListener("pong", () => {
      answered = true;
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) {
        return;
      }

      socket = undefined;
      ready = false;

      if (closed) {
        return;
      }

      const delay = Math.min(1000 * 2 ** attempt++, 30_000);
      process.stderr.write(`buzz hub: relay connection lost, reconnecting in ${delay / 1000}s\n`);
      setTimeout(open, delay);
    });
  }

  function read(data: string) {
    const raw: unknown = JSON.parse(data);
    const parsed = frame.safeParse(raw);

    if (parsed.success) {
      handle(parsed.data);
    } else if (Array.isArray(raw) && handled.has(String(raw[0]))) {
      throw new Error(z.prettifyError(parsed.error));
    }
  }

  function handle(message: z.output<typeof frame>) {
    switch (message[0]) {
      case "AUTH": {
        const signed = sign({
          kind: 22_242,
          content: "",
          tags: [
            ["relay", url],
            ["challenge", message[1]],
          ],
        });

        auth = signed.id;
        socket?.send(JSON.stringify(["AUTH", signed]));

        return;
      }

      case "OK": {
        const [, id, ok, reason] = message;

        if (id !== auth) {
          requests.get(id)?.done(ok ? undefined : reason || "refused");

          return;
        }

        if (!ok) {
          process.stderr.write(`buzz hub: relay refused auth: ${reason}\n`);
          socket?.close();

          return;
        }

        ready = true;
        attempt = 0;

        for (const [sub, { filters }] of subs) {
          req(sub, filters, alive - OVERLAP);
        }

        for (const pending of requests.values()) {
          send(pending.message);
        }

        return;
      }

      case "EVENT": {
        const [, id, received] = message;
        const sub = subs.get(id);

        if (sub && !seen.has(received.id)) {
          seen.add(received.id);

          if (sub.stored) {
            sub.stored.push(received);
          } else {
            sub.onEvent(received);
          }
        }

        requests.get(id)?.events?.push(received);

        return;
      }

      case "EOSE": {
        const id = message[1];
        const pending = requests.get(id);

        if (pending) {
          send(["CLOSE", id]);
          pending.done();
        }

        flush(id);

        return;
      }

      case "CLOSED": {
        const [, id, reason] = message;
        const pending = requests.get(id);

        if (pending) {
          pending.done(reason || "closed");
        } else if (subs.has(id)) {
          flush(id);
          process.stderr.write(`buzz hub: relay closed a subscription: ${reason}\n`);
        }

        return;
      }

      case "NOTICE": {
        process.stderr.write(`buzz hub: relay notice: ${message[1]}\n`);
      }
    }
  }

  function request<T>(
    id: string,
    message: unknown[],
    result: (events: Event[]) => T,
    collect = false,
  ): Promise<T> {
    if (closed) {
      return Promise.reject(new Error("the relay connection is closed"));
    }

    return new Promise((resolve, reject) => {
      const events: Event[] = [];

      const timer = setTimeout(() => {
        done("timed out");
      }, TIMEOUT);

      function done(error?: string) {
        clearTimeout(timer);
        requests.delete(id);

        if (error !== undefined && error !== "") {
          reject(new Error(error));
        } else {
          resolve(result(events));
        }
      }

      const pending: Request = { message, done };

      if (collect) {
        pending.events = events;
      }

      requests.set(id, pending);
      send(message);
    });
  }

  const ping = setInterval(() => {
    if (!ready) {
      return;
    }

    if (!answered) {
      socket?.terminate();

      return;
    }

    answered = false;
    socket?.ping();
  }, PING);

  open();

  return {
    pubkey,
    publish(template) {
      const event = sign(template);

      return request(event.id, ["EVENT", event], () => event);
    },
    subscribe(filters, onEvent) {
      const id = `s${++next}`;
      subs.set(id, { filters, onEvent });
      req(id, filters);

      return () => {
        subs.delete(id);
        send(["CLOSE", id]);
      };
    },
    query(filters) {
      const id = `q${++next}`;

      return request(
        id,
        ["REQ", id, ...filters],
        (events) => [...new Map(events.map((event) => [event.id, event])).values()],
        true,
      );
    },
    close() {
      closed = true;
      clearInterval(ping);

      for (const pending of requests.values()) {
        pending.done("the relay connection is closed");
      }

      socket?.close();
    },
  };
}
