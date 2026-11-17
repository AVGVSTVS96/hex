import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { bring } from "./carry.ts";
import { fromJson } from "./db.ts";
import type { Bound } from "./db.ts";
import { client, decode } from "./wire.ts";
import type { Client } from "./wire.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// store.json in a state folder names the Durable Object that holds this hex's records in place of the folder's hex.db: its Worker's address and the key it answers to.
const Away = z.object({ url: z.url(), key: z.string().min(1) });

const ANSWER_WITHIN = 30_000;
const FIRST_RETRY = 1000;
const LONGEST_RETRY = 30_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a store's home gives beside its records. watch: told after any write, by any process. synced: resolves once this process's writes can't be lost. read: a query that can change nothing, for what no method answers. copy: the records as a SQLite file.
export type Home = {
  readonly dir: string;
  readonly watch: (listener: () => void) => () => void;
  readonly synced: () => Promise<void>;
  readonly read: (text: string, ...bound: Bound[]) => Promise<unknown[]>;
  readonly copy: (to: string) => Promise<void>;
};

export const awayFile = (dir: string) => join(dir, "store.json");

export function remote(dir: string): (Client & Home) | undefined {
  const named = awayFile(dir);

  if (!existsSync(named)) {
    return;
  }

  const { url, key } = fromJson(Away, readFileSync(named, "utf-8"));
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The tenure of the lease a hub runs on is its own: the sessions it starts outlive it, and write as any other process does.
  const { HEX_STORE_TENURE: tenure } = process.env;
  delete process.env.HEX_STORE_TENURE;

  const headers = {
    authorization: `Bearer ${key}`,
    ...(tenure !== undefined && tenure !== "" && { "hex-tenure": tenure }),
  };

  const post = async (path: string, body: string) => {
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(ANSWER_WITHIN),
    });

    const text = await response.text();

    if (!text.startsWith("{")) {
      throw new Error(`hex's store at ${url} answered ${response.status}: ${text.slice(0, 200)}`);
    }

    return text;
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A process's calls reach the object one at a time, so they are answered in the order it made them, as a file answers them.
  let last: Promise<unknown> = Promise.resolve();

  const send = (call: string) => {
    const answered = last.then(() => post("/call", call));
    last = answered.catch(() => null);

    return answered;
  };

  const read = async (text: string, ...bound: Bound[]) =>
    z.array(z.unknown()).parse(decode(await post("/sql", JSON.stringify({ text, bound }))));

  const listeners = new Set<() => void>();
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wait = FIRST_RETRY;

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

  const listen = () => {
    const watching = new URL("/watch", url);
    watching.protocol = watching.protocol === "http:" ? "ws:" : "wss:";
    // SAFETY: Bun's WebSocket takes headers where the web's, whose type this is, takes protocols: https://bun.com/docs/api/websockets#connect-to-a-websocket-server
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- the two types share nothing to narrow through
    const opened = new WebSocket(watching, { headers } as unknown as string[]);
    socket = opened;

    opened.addEventListener("open", () => {
      wait = FIRST_RETRY;
      ring();
    });
    opened.addEventListener("message", ring);
    opened.addEventListener("close", () => {
      if (socket !== opened) {
        return;
      }

      socket = undefined;

      if (listeners.size > 0) {
        retry = setTimeout(listen, wait);
        wait = Math.min(wait * 2, LONGEST_RETRY);
      }
    });
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
        const open = socket;
        socket = undefined;
        open?.close();
      };
    },
    synced: () => Promise.resolve(),
    read,
    copy: (to: string) => bring(read, to),
  };
}
