import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { until } from "../../hub/until.ts";

const BIN = join(import.meta.dir, "../../bin");

const HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS = `import { appendFileSync } from 'fs'
const log = (line: string) => appendFileSync(process.env.HEX_DIR + '/state/hubs', line + ' ' + process.pid + '\\n')
log('start mark=' + process.env.MARK + ' loop=' + (process.env.LOOP ?? 1))
const stop = () => setTimeout(() => (log('stop'), process.exit(0)), 500)
for (const signal of ['SIGHUP', 'SIGTERM'] as const) process.on(signal, stop)
setInterval(() => {}, 1000)
`;

let home: string;
let hex: string;
let loop: ReturnType<typeof Bun.spawn> | undefined;

const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", hex, ...args])
    .stdout.toString()
    .trim();

const hubs = () =>
  existsSync(join(home, "state/hubs"))
    ? readFileSync(join(home, "state/hubs"), "utf-8").trim().split("\n")
    : [];

function commit(hub: string, message: string) {
  writeFileSync(join(hex, "hub/serve.ts"), hub);
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );

  return git("rev-parse", "HEAD");
}

function run(extra: Record<string, string> = {}) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HEX_"))),
    ...extra,
  };

  const spawned = Bun.spawn([join(hex, "bin/hex"), "run"], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });

  loop = spawned;

  return spawned;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "run-"));
  hex = join(home, ".hex");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(hex, "hub"));
  mkdirSync(join(home, "state"));

  for (const script of ["hex", "settings", "update"]) {
    copyFileSync(join(BIN, script), join(hex, "bin", script));
  }

  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nMARK=1\n");
  git("init", "-q", "-b", "main");
});

afterEach(async () => {
  loop?.kill("SIGTERM");
  await loop?.exited;
  loop = undefined;
  rmSync(home, { recursive: true, force: true });
});

test("a restart lets the hub finish before the next one starts, on the settings and bin/hex as they are now", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const running = run();
  await until(() => hubs().length === 1);
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nMARK=2\n");
  copyFileSync(join(hex, "bin/hex"), join(hex, "bin/hex.new"));
  writeFileSync(
    join(hex, "bin/hex.new"),
    readFileSync(join(hex, "bin/hex"), "utf-8").replace(
      "echo $$ >",
      (line) => `export LOOP=2; ${line}`,
    ),
  );
  renameSync(join(hex, "bin/hex.new"), join(hex, "bin/hex"));
  Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
  await until(() => hubs().length === 3);
  const [first, stopped, next] = hubs();
  const pid = first?.split(" ").at(-1);
  expect(first).toBe(`start mark=1 loop=1 ${pid}`);
  expect(stopped).toBe(`stop ${pid}`);
  expect(next).toMatch(/^start mark=2 loop=2 \d+$/u);
  expect(readFileSync(join(home, "state/hub.pid"), "utf-8").trim()).toBe(String(running.pid));
});

test("the hub gets the env of the settings files over .env, so a setting changes without touching .env", async () => {
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { MARK: "settings" } }));
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  run();
  await until(() => hubs().length === 1);
  expect(hubs()[0]).toMatch(/^start mark=settings loop=1 \d+$/u);
});

test("a hub started ahead of its turn waits until the file HEX_AHEAD names is gone", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const ahead = join(home, "ahead");
  writeFileSync(ahead, "");
  run({ HEX_AHEAD: ahead });
  await Bun.sleep(500);
  expect(hubs()).toEqual([]);
  rmSync(ahead);
  await until(() => hubs().length === 1);
});

test("a stop waits for the hub to finish", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const running = run();
  await until(() => hubs().length === 1);
  running.kill("SIGTERM");
  expect(await running.exited).toBe(0);
  const pid = hubs()[0]?.split(" ").at(-1);
  expect(hubs()).toEqual([`start mark=1 loop=1 ${pid}`, `stop ${pid}`]);
  expect(existsSync(join(home, "state/hub.pid"))).toBe(false);
});

test("hex stop returns once the hub has finished, so whatever starts hex next never runs two", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  run();
  await until(() => hubs().length === 1);
  expect(await Bun.spawn([join(hex, "bin/hex"), "stop"]).exited).toBe(0);
  const pid = hubs()[0]?.split(" ").at(-1);
  expect(hubs()).toEqual([`start mark=1 loop=1 ${pid}`, `stop ${pid}`]);
  expect(existsSync(join(home, "state/hub.pid"))).toBe(false);
});

test("a commit whose hub can't start goes back to the last one General connected on, and bin/update won't take it again", async () => {
  const good = commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(join(home, "state/good"), `${good}\n`);
  const bad = commit("process.exit(1)\n", "a hub that crashes");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(home, "origin")]);
  git("remote", "add", "origin", join(home, "origin"));
  git("push", "-q", "origin", "main");
  run();
  await until(() => hubs().length === 1);
  expect(git("rev-parse", "HEAD")).toBe(good);
  expect(readFileSync(join(home, "state/bad"), "utf-8").trim()).toBe(bad);
  expect(readFileSync(join(home, "state/rollback"), "utf-8")).toContain(
    `hex ${bad.slice(0, 7)} ("a hub that crashes") couldn't start`,
  );
  const update = Bun.spawnSync([join(hex, "bin/update")]);
  expect(update.exitCode).toBe(1);
  expect(update.stdout.toString()).toContain(
    `not updated: hex ${bad.slice(0, 7)} couldn't start here`,
  );
  expect(git("rev-parse", "HEAD")).toBe(good);
}, 20_000);

const curlThatRecordsWhatGeneralIsTold = () => {
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\ncat >> "${home}/told"\nprintf '%s\\n' "$@" >> "${home}/told"\n`,
    {
      mode: 0o755,
    },
  );

  return {
    PATH: `${bin}:${process.env.PATH}`,
    read: () => (existsSync(join(home, "told")) ? readFileSync(join(home, "told"), "utf-8") : ""),
  };
};

test("a .env line that fails stops hex as failed before any hub or job starts, and tells General which line, never what it says", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(
    join(home, ".env"),
    "TELEGRAM_BOT_TOKEN=test\nHEX_MAIN_THREAD=-100\nHEADERS=x-key: s3cret\n",
  );
  const { PATH, read } = curlThatRecordsWhatGeneralIsTold();
  const running = run({ PATH });
  expect(await running.exited).toBe(1);
  const printed = await new Response(running.stderr).text();
  expect(printed).toContain("hex can't start");
  expect(printed).toMatch(/line 3 of .*\.env fails/u);
  expect(printed).not.toContain("s3cret");
  expect(read()).toContain("chat_id=-100");
  expect(read()).toContain("fails as a command");
  expect(read()).not.toContain("s3cret");
  expect(hubs()).toEqual([]);
});

test("hex that can't start tells General once, until a hub connects again", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nHEX_MAIN_THREAD=-100\nbroken line\n");
  const { PATH, read } = curlThatRecordsWhatGeneralIsTold();
  expect(await run({ PATH }).exited).toBe(1);
  expect(await run({ PATH }).exited).toBe(1);
  expect(read().match(/sendMessage/gu)).toHaveLength(1);
  expect(readdirSync(join(home, "state")).filter((file) => file.startsWith("down."))).toHaveLength(
    1,
  );
});

test("a .env line that doesn't even parse still tells General, and a missing .env says so", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(
    join(home, ".env"),
    "TELEGRAM_BOT_TOKEN=test\nHEX_MAIN_THREAD=-100\nX=a(b)s3cret\n",
  );
  const { PATH, read } = curlThatRecordsWhatGeneralIsTold();
  expect(await run({ PATH }).exited).toBe(1);
  expect(read()).toContain("chat_id=-100");
  expect(read()).not.toContain("s3cret");
  rmSync(join(home, ".env"));
  const missing = run({ PATH });
  expect(await missing.exited).toBe(1);
  expect(await new Response(missing.stderr).text()).toContain("sets no TELEGRAM_BOT_TOKEN");
});

test("a notice that couldn't be sent is tried again at the next start", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nHEX_MAIN_THREAD=-100\nbroken line\n");
  const { PATH, read } = curlThatRecordsWhatGeneralIsTold();
  writeFileSync(join(home, "fake-bin/curl"), `#!/bin/sh\necho tried >> "${home}/told"\nexit 7\n`, {
    mode: 0o755,
  });
  expect(await run({ PATH }).exited).toBe(1);
  expect(await run({ PATH }).exited).toBe(1);
  expect(read().match(/tried/gu)).toHaveLength(2);
  expect(readdirSync(join(home, "state")).filter((file) => file.startsWith("down."))).toEqual([]);
});

test("a hub that can't start, with no earlier hex to go back to, stops hex as failed and tells General", async () => {
  commit("process.exit(1)\n", "a hub that crashes");
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nHEX_MAIN_THREAD=-100\n");
  const { PATH, read } = curlThatRecordsWhatGeneralIsTold();
  expect(await run({ PATH }).exited).toBe(1);
  expect(read()).toContain("its hub exited three times within a minute");
}, 20_000);
