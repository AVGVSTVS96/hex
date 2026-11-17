/* oxlint-disable max-classes-per-file -- the two ways a call fails that its caller tells apart */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { bring } from "./carry.ts";
import { fromJson } from "./db.ts";
import type { Bound } from "./db.ts";
import { client, decode } from "./wire.ts";
import type { Client } from "./wire.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store call that didn't reach the object, or whose answer never came back, so it may or may not have landed.
export class UnreachedError extends Error {
  override name = "UnreachedError";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The object refused this process's tenure: another machine's hub holds hex now.
export class LostError extends Error {
  override name = "LostError";
}

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

const ErrorReply = z.object({ error: z.string() });

function saidIn(text: string) {
  try {
    return ErrorReply.parse(JSON.parse(text)).error;
  } catch {
    return text;
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
// What a store's home gives beside its records. watch: told after any write, by any process, and when a home that wasn't answering answers again. synced: resolves once this process's writes can't be lost, and rejects while one may be. read: a query that can change nothing, for what no method answers. copy: the records as a SQLite file.
export type Home = {
  readonly dir: string;
  readonly watch: (listener: () => void) => () => void;
  readonly synced: () => Promise<void>;
  readonly read: (text: string, ...bound: Bound[]) => Promise<unknown[]>;
  readonly copy: (to: string) => Promise<void>;
};

export const awayFile = (dir: string) => join(dir, "store.json");

export function remote(dir: string, times = TIMES): (Client & Home) | undefined {
  const named = awayFile(dir);

  if (!existsSync(named)) {
    return;
  }

  const away = fromJson(StoreJson, readFileSync(named, "utf-8"));
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The tenure of the lease a hub runs on is its own: the sessions it starts outlive it, and write as any other process does.
  const { HEX_STORE_TENURE: tenure } = process.env;
  delete process.env.HEX_STORE_TENURE;

  const headers = {
    authorization: `Bearer ${away.key}`,
    ...(tenure !== undefined && tenure !== "" && { "hex-tenure": tenure }),
  };

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

    if (response.status === 409) {
      throw new LostError(saidIn(text));
    }

    if (response.status >= 500 || response.status === 429 || !text.startsWith("{")) {
      throw new UnreachedError(
        `hex's store at ${away.url} answered ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return text;
  };

  const listeners = new Set<() => void>();

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
      probeLater();
    }
  };

  const probe = async () => {
    try {
      await reach("call", PROBE);
      down = undefined;
      wait = times.firstRetry;
      ring();
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

  const send = (call: string) => {
    const answered = last.then(async () => await guarded("call", call));
    last = answered.catch(() => null);

    return answered;
  };

  const read = async (text: string, ...bound: Bound[]) =>
    z.array(z.unknown()).parse(decode(await guarded("sql", JSON.stringify({ text, bound }))));

  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let reconnectIn = times.firstRetry;

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
    const watching = at(away, "watch");
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
    ...client(send),
    dir,
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
