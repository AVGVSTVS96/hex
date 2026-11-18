import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { bring } from "./carry.ts";
import { fromJson } from "./db.ts";
import type { Bound } from "./db.ts";
import { CONTRACT } from "./domains.ts";
import { LostError, OtherStoreError, UnreachedError } from "./errors.ts";
import { client, decode } from "./wire.ts";
import type { Client } from "./wire.ts";

export { LostError, MovedError, OtherStoreError, RefusedError, UnreachedError } from "./errors.ts";

const ON_THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// store.json in a state folder names the Durable Object that holds this hex's records in place of the folder's hex.db: its Worker's address (https, so the key never crosses in the clear), the object's name, and the key the Worker answers to.
export const StoreJson = z.object({
  url: z.url().refine((url) => {
    const { protocol, hostname } = new URL(url);

    return protocol === "https:" || (protocol === "http:" && ON_THIS_MACHINE.has(hostname));
  }, "a store's address is https: plain http only for one on this machine"),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
  key: z.string().min(32),
});

export type Away = z.infer<typeof StoreJson>;

export const at = ({ url, name }: Pick<Away, "url" | "name">, route: string) =>
  new URL(`/${name}/${route}`, url);

const LostReply = z.object({ error: z.string(), lost: z.literal(true) });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the object said when it refused this process's tenure, if this is the object's word: any other 409, like one Cloudflare's edge sends for its own errors, isn't.
const OtherReply = z.object({ error: z.string(), other: z.literal(true) });

function otherIn(text: string): string | null {
  try {
    return OtherReply.parse(JSON.parse(text)).error;
  } catch {
    return null;
  }
}

function lostIn(text: string): string | null {
  try {
    return LostReply.parse(JSON.parse(text)).error;
  } catch {
    return null;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A reply that says the store would refuse every call now counts as no answer, so the calls behind it fail fast as for an outage.
function decodeEvery(text: string) {
  try {
    decode(text);
  } catch (error) {
    if (error instanceof UnreachedError) {
      throw error;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A heartbeat finds a watch socket that went quiet because the line under it died, which no close event tells of.
const TIMES = {
  answerWithin: 10_000,
  firstRetry: 1000,
  longestRetry: 30_000,
  heartbeat: 30_000,
};

const PROBE = JSON.stringify({ domain: "clock", method: "now", args: [] });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a store's home gives beside its records. claim: makes this process the hub, refusing every hub that claimed before it. watch: told after any write, by any process, and when a home that wasn't answering answers again. synced: resolves once this process's writes can't be lost, and rejects while one may be. read: a query that can change nothing, for what no method answers. copy: the records as a SQLite file.
export type Home = {
  readonly dir: string;
  readonly claim: () => Promise<number>;
  readonly watch: (listener: () => void) => () => void;
  readonly synced: () => Promise<void>;
  readonly read: (text: string, ...bound: Bound[]) => Promise<unknown[]>;
  readonly copy: (to: string) => Promise<void>;
};

export const awayFile = (dir: string) => join(dir, "store.json");

const Lease = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Claimed = z.object({ value: z.number().int().positive() });

type Times = typeof TIMES;

type Asking = { authorization: string; "hex-tenure"?: string };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A socket the object tells of every write on, opened while anyone listens and opened again when it closes or stops answering its heartbeat. Each opening rings, since writes may have gone by unheard.
function watcher(address: URL, headers: Asking, times: Times) {
  const listeners = new Set<() => void>();
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let reconnectIn = times.firstRetry;

  const ring = () => {
    for (const each of listeners) {
      try {
        each();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const hangUp = () => {
    clearInterval(beat);
    clearTimeout(deadline);
    beat = undefined;
    deadline = undefined;
    const open = socket;
    socket = undefined;
    open?.close();
  };

  const listen = () => {
    retry = undefined;
    const watching = new URL(address);
    watching.protocol = watching.protocol === "http:" ? "ws:" : "wss:";
    // SAFETY: Bun's WebSocket takes headers where the web's, whose type this is, takes protocols: https://bun.com/docs/api/websockets#connect-to-a-websocket-server
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- the two types share nothing to narrow through
    const opened = new WebSocket(watching, { headers } as unknown as string[]);
    socket = opened;

    const gone = () => {
      if (socket !== opened) {
        return;
      }

      hangUp();

      if (listeners.size > 0) {
        retry = setTimeout(listen, reconnectIn);
        reconnectIn = Math.min(reconnectIn * 2, times.longestRetry);
      }
    };

    opened.addEventListener("open", () => {
      reconnectIn = times.firstRetry;
      ring();
      beat = setInterval(() => {
        deadline ??= setTimeout(gone, times.answerWithin);
        opened.send("ping");
      }, times.heartbeat);
    });
    opened.addEventListener("message", ({ data }) => {
      clearTimeout(deadline);
      deadline = undefined;

      if (data !== "pong") {
        ring();
      }
    });
    opened.addEventListener("close", gone);
  };

  return {
    ring,
    watch: (listener: () => void) => {
      listeners.add(listener);

      if (socket === undefined && retry === undefined) {
        listen();
      }

      return () => {
        listeners.delete(listener);

        if (listeners.size > 0) {
          return;
        }

        clearTimeout(retry);
        retry = undefined;
        hangUp();
      };
    },
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A process that finds the object not answering says so in the state folder, so the next process, like a hook, fails at once instead of waiting out its own time, until one gets an answer again or the word is older than the longest wait between tries.
function word(dir: string, times: Times) {
  const file = join(dir, "store.down");

  return {
    say: (why: string) => {
      try {
        writeFileSync(file, `${why}\n`);
      } catch {
        // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
        // Only a word to other processes: this one fails fast without it.
      }
    },
    heard: (): string | null => {
      try {
        return Date.now() - statSync(file).mtimeMs < times.longestRetry
          ? readFileSync(file, "utf-8").trim()
          : null;
      } catch {
        return null;
      }
    },
    clear: () => {
      rmSync(file, { force: true });
    },
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Ends the lease the object keeps for hex, so a hub with no lease, on a hex that stopped using a lease tool, can claim it.
export async function unlease(dir: string) {
  const away = fromJson(StoreJson, readFileSync(awayFile(dir), "utf-8"));

  const response = await fetch(at(away, "lease/clear"), {
    method: "POST",
    headers: { authorization: `Bearer ${away.key}` },
    body: "{}",
    signal: AbortSignal.timeout(TIMES.answerWithin),
  });

  decode(await response.text());
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// shared: whether this client tells the folder's other processes when the object stops answering, and hears them; a backup's slow page or a lost hub paying what it owed keeps that to itself.
const alone = { say: (_why: string) => null, heard: (): string | null => null, clear: () => null };

export function remote(dir: string, times = TIMES, shared = true): (Client & Home) | undefined {
  const named = awayFile(dir);

  if (!existsSync(named)) {
    return;
  }

  const away = fromJson(StoreJson, readFileSync(named, "utf-8"));
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The number of the lease a hub runs on, from whatever passes hex between machines, is its own: the sessions it starts outlive it, and write as any other process does.
  const { HEX_STORE_LEASE: lease } = process.env;
  delete process.env.HEX_STORE_LEASE;
  const claimant = crypto.randomUUID();
  const headers: Asking = { authorization: `Bearer ${away.key}` };
  const socket = watcher(at(away, "watch"), headers, times);
  const elsewhere = shared ? word(dir, times) : alone;

  const reach = async (route: string, body: string) => {
    let response: Response;
    let text: string;

    try {
      response = await fetch(at(away, route), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(times.answerWithin),
      });
      text = await response.text();
    } catch (error) {
      throw new UnreachedError(`hex's store at ${away.url} didn't answer: ${String(error)}`, {
        cause: error,
      });
    }

    const lostTo = response.status === 409 ? lostIn(text) : null;

    if (lostTo !== null) {
      throw new LostError(lostTo);
    }

    const other = response.status === 503 ? otherIn(text) : null;

    if (other !== null) {
      throw new OtherStoreError(other);
    }

    if (
      response.status >= 500 ||
      [401, 404, 409, 429].includes(response.status) ||
      !text.startsWith("{")
    ) {
      throw new UnreachedError(
        `hex's store at ${away.url} answered ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    decodeEvery(text);

    return text;
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Once a call can't reach the object, the calls behind it fail at once rather than each waiting out its time, until a probe gets an answer; the probe's timer holds no process open.
  let down: UnreachedError | undefined;
  let lost: LostError | undefined;
  let wait = times.firstRetry;

  const probeLater = () => {
    setTimeout(() => void probe(), wait).unref();
    wait = Math.min(wait * 2, times.longestRetry);
  };

  const fell = (error: Error) => {
    if (error instanceof LostError) {
      lost ??= error;
    } else if (error instanceof UnreachedError && down === undefined) {
      down = error;
      elsewhere.say(error.message);
      probeLater();
    }
  };

  const probe = async () => {
    try {
      await reach("call", PROBE);
      down = undefined;
      wait = times.firstRetry;
      elsewhere.clear();
      socket.ring();
    } catch (error) {
      if (error instanceof LostError) {
        lost ??= error;
        down = undefined;
      } else {
        probeLater();
      }
    }
  };

  const guarded = async (route: string, body: string) => {
    if (lost !== undefined) {
      throw lost;
    }

    const heard = down === undefined ? elsewhere.heard() : null;

    if (heard !== null) {
      down = new UnreachedError(`another process found hex's store not answering: ${heard}`);
      probeLater();
    }

    if (down !== undefined) {
      throw new UnreachedError(`hex's store at ${away.url} isn't answering: ${down.message}`);
    }

    try {
      return await reach(route, body);
    } catch (error) {
      if (error instanceof Error) {
        fell(error);
      }

      throw error;
    }
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A process's calls reach the object one at a time, so they are answered in the order it made them, as a file answers them.
  let last: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(call: () => Promise<T>) => {
    const answered = last.then(call);
    last = answered.catch(() => null);

    return answered;
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The object takes this process's calls as a hub's once it has given it a tenure of its own.
  const claim = async () => {
    const leased = lease === undefined || lease === "" ? undefined : Lease.safeParse(lease).data;

    if (leased === undefined && lease !== undefined && lease !== "") {
      throw new LostError(`HEX_STORE_LEASE is ${JSON.stringify(lease)}, not a whole number`);
    }

    const asked = {
      claimant,
      contract: CONTRACT,
      ...(leased !== undefined && { lease: leased }),
    };

    return await inTurn(async () => {
      const { value } = Claimed.parse(JSON.parse(await guarded("claim", JSON.stringify(asked))));
      headers["hex-tenure"] = String(value);

      return value;
    });
  };

  const read = async (text: string, ...bound: Bound[]) =>
    z.array(z.unknown()).parse(decode(await guarded("sql", JSON.stringify({ text, bound }))));

  return {
    ...client(async (call) => await inTurn(async () => await guarded("call", call))),
    dir,
    claim,
    watch: socket.watch,
    synced: async () => {
      await last;

      if (lost !== undefined) {
        throw lost;
      }

      if (down !== undefined) {
        throw down;
      }
    },
    read,
    copy: async (to: string) => {
      await bring(read, to);
    },
  };
}
