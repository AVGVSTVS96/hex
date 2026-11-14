import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A hub of its own, with no channel's token, so each channel that starts says it can't.
function serve(port: number, extra: Record<string, string> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("HEX_") && !name.endsWith("_TOKEN"),
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
  const file = join(dir, "ahead");
  writeFileSync(file, "");
  const { started, output } = serve(port, { HEX_AHEAD: file });

  await until(() => readFileSync(file, "utf-8") === "ready\n" || started.exitCode !== null);
  await Bun.sleep(500);
  expect(started.exitCode).toBeNull();
  expect(output.said).not.toContain("TELEGRAM_BOT_TOKEN");
  expect(readdirSync(dir)).toEqual(["ahead"]);
  rmSync(file);
  await until(() => output.said.includes("TELEGRAM_BOT_TOKEN"));
});
