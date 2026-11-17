import { z } from "zod";

import { METHODS } from "./domains.ts";
import type { Domains } from "./domains.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One call to a store, as it crosses to the store's home and back. JSON has no undefined, so an argument left out to take its default travels as a place in `absent`.
const CallJson = z.object({
  domain: z.string(),
  method: z.string(),
  args: z.array(z.unknown()),
  absent: z.array(z.number()).optional(),
});

const ReplyJson = z.union([
  z.object({ error: z.string() }),
  z.object({ value: z.unknown().optional() }),
]);

export type Reply = z.infer<typeof ReplyJson>;

export type Send = (call: string) => Promise<string>;

// oxlint-disable-next-line anti-slop/no-unknown-returns -- any of the store's methods, each of which says its own type to its callers
type Method = (...args: unknown[]) => unknown;

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a property of one of the store's own domains, named in METHODS: this checks hex's code, not input
const MethodValue = z.custom<Method>((value) => typeof value === "function");

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
export function answering(domains: Domains): (call: string) => Reply {
  const methods = methodsOf(domains);

  return (call) => {
    try {
      const { domain, method, args, absent = [] } = CallJson.parse(JSON.parse(call));
      const answer = methods.get(`${domain}.${method}`);

      if (answer === undefined) {
        return { error: `the store has no ${domain}.${method}` };
      }

      return { value: answer(...args.map((arg, at) => (absent.includes(at) ? undefined : arg))) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- what a store's own method returned at its home: the client's types say what, since both ends are one hex
export function decode(text: string): unknown {
  const reply = ReplyJson.parse(JSON.parse(text));

  if ("error" in reply) {
    throw new Error(reply.error);
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
