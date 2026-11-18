import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listen } from "./hub.ts";
import { until } from "./until.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A hub a stop left running, finishing a call, as KillMode=process left one: it holds the port until it exits.
const OLD_HUB_FINISHING_A_CALL_HOLDS_THE_PORT = `const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: () => new Response('old hub') })
console.log(listener.port)
setInterval(() => {}, 1000)`;

let dir: string;
let old: ReturnType<typeof Bun.spawn> | undefined;
let hub: ReturnType<typeof Bun.spawn> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serve-"));
});

afterEach(async () => {
  for (const child of [hub, old]) {
    child?.kill("SIGKILL");
  }

  await Promise.all([hub?.exited, old?.exited]);
  hub = undefined;
  old = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function oldHub() {
  const started = Bun.spawn(["bun", "-e", OLD_HUB_FINISHING_A_CALL_HOLDS_THE_PORT], {
    stdout: "pipe",
  });

  old = started;
  const { value } = await started.stdout.getReader().read();

  return Number(new TextDecoder().decode(value));
}

function fakeSystemdNotify() {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "systemd-notify"),
    `#!/bin/sh\necho "$NOTIFY_SOCKET $*" > "${dir}/told"\n`,
    {
      mode: 0o755,
    },
  );

  return { PATH: `${bin}:${process.env.PATH}`, told: join(dir, "told") };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A hub of its own, with no channel's token, so each channel that starts says it can't.
function serve(port: number, extra: Record<string, string> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("HEX_") && !name.endsWith("_TOKEN") && name !== "NOTIFY_SOCKET",
    ),
  );

  const states = Object.fromEntries(
    ["TELEGRAM", "DISCORD", "BUZZ", "T3", "VOICE"].map((app) => [
      `${app}_STATE_DIR`,
      join(dir, app),
    ]),
  );

  const started = Bun.spawn(["bun", join(import.meta.dir, "serve.ts")], {
    env: { ...env, ...states, HEX_DIR: dir, HEX_PORT: String(port), ...extra },
    stdout: "ignore",
    stderr: "pipe",
  });

  hub = started;
  const output = { said: "" };
  void (async () => {
    for await (const chunk of started.stderr) {
      output.said += new TextDecoder().decode(chunk);
    }
  })();

  return { started, output };
}

test("a hub that finds the port held waits for it instead of exiting, which bin/hex would count as a failed start, and a stop ends it while it waits", async () => {
  const port = await oldHub();
  const { started: waiting, output } = serve(port);

  await until(() => output.said.includes(`port ${port} is in use`) || waiting.exitCode !== null);
  await Bun.sleep(1500);
  expect(waiting.exitCode).toBeNull();
  waiting.kill("SIGTERM");
  expect(await waiting.exited).toBe(0);
});

test("the next hub listens once the one holding the port exits", async () => {
  const port = await oldHub();
  let server: ReturnType<typeof Bun.serve> | undefined;
  const listening = listen(port).then((listener) => (server = listener));
  await Bun.sleep(1500);
  expect(server).toBeUndefined();
  old?.kill("SIGTERM");
  const listener = await listening;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/nowhere`);
    expect(await response.text()).toBe("Not Found");
  } finally {
    await listener.stop(true);
  }
});

test("a hub started ahead of its turn says it's ready in the file HEX_AHEAD names, and starts its channels only once the file is gone", async () => {
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(free.port);
  await free.stop(true);
  const { PATH, told } = fakeSystemdNotify();
  const file = join(dir, "ahead");
  writeFileSync(file, "");
  const { started, output } = serve(port, { HEX_AHEAD: file, PATH });

  await until(() => readFileSync(file, "utf-8") === "ready\n" || started.exitCode !== null);
  await Bun.sleep(500);
  expect(started.exitCode).toBeNull();
  expect(output.said).not.toContain("TELEGRAM_BOT_TOKEN");
  expect(existsSync(told)).toBe(false);
  expect(readdirSync(dir).toSorted()).toEqual(["ahead", "bin"]);
  rmSync(file);
  await until(() => output.said.includes("TELEGRAM_BOT_TOKEN"));
});

test("a hub that systemd started ahead of its turn tells it it's ready as it says so in the file, so the start returns while it waits", async () => {
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(free.port);
  await free.stop(true);
  const { PATH, told } = fakeSystemdNotify();
  const file = join(dir, "ahead");
  writeFileSync(file, "");
  const { started } = serve(port, { HEX_AHEAD: file, NOTIFY_SOCKET: join(dir, "notify"), PATH });

  expect(await until(() => existsSync(told) || started.exitCode !== null)).toBe(true);
  expect(readFileSync(told, "utf-8")).toBe(`${join(dir, "notify")} --ready\n`);
  expect(readFileSync(file, "utf-8")).toBe("ready\n");
  expect(started.exitCode).toBeNull();
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store across the network the hub's state/store.json names: until up() it answers as one that can't be reached, then claims as claims says.
function objectStore(claims: () => Response) {
  let reachable = false;
  const asked: string[] = [];
  const bodies: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const route = new URL(request.url).pathname.split("/").slice(2).join("/");
      asked.push(route);
      bodies.push(await request.text());

      if (!reachable) {
        return new Response("down", { status: 503 });
      }

      return route === "claim" ? claims() : Response.json({ value: new Date().toISOString() });
    },
  });

  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(
    join(dir, "state", "store.json"),
    JSON.stringify({ url: server.url.origin, name: "hex", key: "k".repeat(32) }),
    { mode: 0o600 },
  );

  return {
    asked,
    bodies,
    up: () => {
      reachable = true;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function freePort() {
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(free.port);
  await free.stop(true);

  return port;
}

test("a hub takes hex over before it starts its channels, waiting while its store can't be reached instead of exiting", async () => {
  const object = objectStore(() => Response.json({ value: 1 }));
  const port = await freePort();

  try {
    const { started, output } = serve(port);
    await until(() => output.said.includes("this hub takes hex over") || started.exitCode !== null);
    await Bun.sleep(1500);
    expect(started.exitCode).toBeNull();
    expect(output.said).not.toContain("TELEGRAM_BOT_TOKEN");

    object.up();
    await until(() => output.said.includes("TELEGRAM_BOT_TOKEN"));
    expect(output.said.indexOf("answers again")).toBeLessThan(
      output.said.indexOf("TELEGRAM_BOT_TOKEN"),
    );
    expect(object.asked.filter((route) => route === "claim").length).toBeGreaterThan(1);
  } finally {
    await object.stop();
  }
});

test("a hub whose claim another machine's newer one refuses stops as one that lost hex, before it listens", async () => {
  const object = objectStore(() =>
    Response.json(
      { error: "lease 1 is older than lease 2 the store has seen", lost: true },
      { status: 409 },
    ),
  );

  object.up();
  const port = await freePort();

  try {
    const { started } = serve(port);
    expect(await started.exited).toBe(3);
  } finally {
    await object.stop();
  }
});

test("a hub refused as it claims hex still lands what it owed as fact before it stops", async () => {
  const object = objectStore(() =>
    Response.json({ error: "lease 7 is older than lease 8", lost: true }, { status: 409 }),
  );

  object.up();
  writeFileSync(
    join(dir, "state", "owed.telegram.json"),
    `${JSON.stringify({
      write: {
        kind: "deliver",
        row: { key: "telegram:1:90", to: "-100:7", from: "telegram", author: "hex", body: "on it" },
        by: "s",
      },
      tenure: 3,
    })}\n`,
  );
  const port = await freePort();

  try {
    const { started } = serve(port);
    expect(await started.exited).toBe(3);
    expect(object.bodies.some((body) => body.includes("telegram:1:90"))).toBe(true);
    expect(existsSync(join(dir, "state", "owed.telegram.json"))).toBe(false);
  } finally {
    await object.stop();
  }
});

test("a hub whose store runs another hex's code tells the owner at once that it needs a deploy, and waits", async () => {
  const object = objectStore(() =>
    Response.json(
      {
        error: "hex's store runs another hex's code (abc): deploy this hex's with hex store deploy",
        other: true,
      },
      { status: 503 },
    ),
  );

  object.up();
  const port = await freePort();

  try {
    const { started, output } = serve(port);

    const told = await Promise.race([
      until(() => output.said.includes("hex can't start") || started.exitCode !== null),
      Bun.sleep(15_000),
    ]);

    expect(told).toBe(true);
    expect(output.said).toContain("hex store deploy");
    expect(started.exitCode).toBeNull();
  } finally {
    await object.stop();
  }
});
