import { z } from "zod";

import { METHODS } from "./domains.ts";
import type { Domains } from "./domains.ts";
import { RefusedError, UnreachedError } from "./errors.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What hex rollback went back from, as bin/hex keeps it in state/refused: the newest commit refused, then the one hex went back to.
export const Refusal = z.string().regex(/^[0-9a-f]{40,64} [0-9a-f]{40,64}$/u);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The most a claim says, and the store keeps, of them: the oldest are long behind main.
export const REFUSALS_KEPT = 100;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One call to a store, as it crosses to the store's home and back. JSON has no undefined, so an argument left out to take its default travels as a place in `absent`.
const CallJson = z.object({
  domain: z.string(),
  method: z.string(),
  args: z.array(z.unknown()),
  absent: z.array(z.number()).optional(),
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// JSON gives every object a prototype, so a lookup table a method made without one, like threads.names(), says so, or a key like toString would find Object's method.
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// An error says `every` when the home would refuse any call now, not just this one: a method it doesn't have yet, or a disk that failed under it.
export const ReplyJson = z.union([
  z.object({ error: z.string(), every: z.literal(true).optional() }),
  z.object({ value: z.unknown().optional(), prototype: z.null().optional() }),
]);

export type Reply = z.infer<typeof ReplyJson>;

export type Send = (call: string) => Promise<string>;

// oxlint-disable-next-line anti-slop/no-unknown-returns -- any of the store's methods, each of which says its own type to its callers
type Method = (...args: unknown[]) => unknown;

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a property of one of the store's own domains, named in METHODS: this checks hex's code, not input
const MethodValue = z.custom<Method>((value) => typeof value === "function");

// SQLite's failures of the file under it, rather than of the call: https://www.sqlite.org/rescode.html
const HOME_FAILED = /SQLITE_(BUSY|LOCKED|IOERR|FULL|CANTOPEN|READONLY|CORRUPT|NOTADB)/u;
const SqliteFailure = z.object({ code: z.string() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// SQL that names what its records lack. On a file, it's the hub's own commit that doesn't fit its hex.db, which a rollback fixes once the hub exits. In a Worker, deployed apart from the hub, it's the store's code that doesn't fit its own records, which every call meets alike until a deploy fixes it.
const SCHEMA_FAILED = /no such (table|column|function|index)|has no column named/u;

const NAMED = new Map<string, string[]>(Object.entries(METHODS));

function methodsOf(domains: Domains): Map<string, Method> {
  const methods = new Map<string, Method>();

  for (const [domain, kept] of Object.entries(domains)) {
    for (const name of NAMED.get(domain) ?? []) {
      const method = MethodValue.parse(
        Object.getOwnPropertyDescriptor(kept, name)?.value ??
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(kept), name)?.value,
      );

      methods.set(`${domain}.${name}`, (...args) => method.apply(kept, args));
    }
  }

  return methods;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A home's answers to the calls that reach it: what the method returned, or the words it threw.
export function answering(domains: Domains, deployed = false): (call: string) => Reply {
  const methods = methodsOf(domains);

  return (call) => {
    try {
      const { domain, method, args, absent = [] } = CallJson.parse(JSON.parse(call));
      const answer = methods.get(`${domain}.${method}`);

      if (answer === undefined) {
        return {
          error: `the store has no ${domain}.${method}: it is older than this hex`,
          every: true,
        };
      }

      const value = answer(...args.map((arg, at) => (absent.includes(at) ? undefined : arg)));

      return value !== null && value !== undefined && Object.getPrototypeOf(value) === null
        ? { value, prototype: null }
        : { value };
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      const { code = said } = SqliteFailure.safeParse(error).data ?? {};

      return HOME_FAILED.test(code) || (deployed && SCHEMA_FAILED.test(said))
        ? { error: said, every: true }
        : { error: said };
    }
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- what a store's own method returned at its home: the client's types say what, since both ends are one hex
export function decode(text: string): unknown {
  const reply = ReplyJson.parse(JSON.parse(text));

  if ("error" in reply) {
    throw reply.every === true ? new UnreachedError(reply.error) : new RefusedError(reply.error);
  }

  if (reply.prototype === null) {
    Object.setPrototypeOf(reply.value, null);
  }

  return reply.value;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A method with two overloads keeps both: inferring from an overloaded function otherwise gives only its last.
type Remote<Domain> = {
  readonly [Name in keyof Domain]: Domain[Name] extends {
    (...args: infer First): infer FirstResult;
    (...args: infer Second): infer SecondResult;
  }
    ? {
        (...args: First): Promise<FirstResult>;
        (...args: Second): Promise<SecondResult>;
      }
    : never;
};

export type Client = { readonly [Name in keyof Domains]: Remote<Domains[Name]> };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store as every caller holds it: each domain's methods, answered by the store's home, wherever that is.
export function client(send: Send): Client {
  const calls = Object.fromEntries(
    Object.entries(METHODS).map(([domain, names]) => [
      domain,
      Object.fromEntries(
        names.map((name) => [
          name,
          async (...args: unknown[]) => {
            const absent = args.flatMap((arg, at) => (arg === undefined ? [at] : []));

            return decode(
              await send(
                JSON.stringify({
                  domain,
                  method: name,
                  args,
                  ...(absent.length > 0 && { absent }),
                }),
              ),
            );
          },
        ]),
      ),
    ]),
  );

  // SAFETY: METHODS names every method of every domain, and each call resolves to what that method returns at the store's home.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- a table built from names has no type of its own to narrow from
  return calls as unknown as Client;
}
