import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { pulser } from "./pulse.ts";

const heard: { headers: Headers; body: string }[] = [];

const watch = Bun.serve({
  port: 0,
  fetch: async (request) => {
    heard.push({ headers: request.headers, body: await request.text() });

    return new Response(null, { status: 204 });
  },
});

afterEach(() => {
  heard.length = 0;
});

test("a pulse is signed the Standard Webhooks way and names the machine", async () => {
  await pulser(watch.url.href, "secret", "server")(1_000_000);

  const [{ headers, body } = { headers: new Headers(), body: "" }] = heard;
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");

  const signature = createHmac("sha256", "secret")
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  expect(JSON.parse(body)).toEqual({ machine: "server" });
  expect(timestamp).toBe("1000");
  expect(headers.get("webhook-signature")).toBe(`v1,${signature}`);
});

test("hex pulses at most once a minute, and not at all without a watch", async () => {
  const pulse = pulser(watch.url.href, "secret");

  expect(await pulse(0)).toBe(true);
  expect(await pulse(59_999)).toBe(false);
  expect(await pulse(60_000)).toBe(true);
  expect(heard).toHaveLength(2);

  expect(await pulser("", "secret")(0)).toBe(false);
  expect(await pulser(watch.url.href, "")(0)).toBe(false);
});

test("a watch that can't be reached costs the hub nothing", async () => {
  expect(await pulser("http://127.0.0.1:9/", "secret")(0)).toBe(true);
});
