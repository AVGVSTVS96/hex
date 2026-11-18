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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { until } from "../hub/until.ts";

const BIN = import.meta.dir;

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
  process.env.XDG_STATE_HOME = join(home, "xdg-state");

  for (const script of ["hex", "settings", "update"]) {
    copyFileSync(join(BIN, script), join(hex, "bin", script));
  }

  for (const module of ["ahead.ts", "ready.ts"]) {
    copyFileSync(join(BIN, "../hub", module), join(hex, "hub", module));
  }

  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nMARK=1\n");
  git("init", "-q", "-b", "main");
});

const leftIn = (folder: string) =>
  Bun.spawnSync(["pgrep", "-f", folder]).stdout.toString().trim().split("\n").filter(Boolean);

afterEach(async () => {
  loop?.kill("SIGTERM");
  await loop?.exited;
  loop = undefined;

  for (const signal of ["TERM", "KILL"]) {
    Bun.spawnSync(["pkill", `-${signal}`, "-f", home]);

    for (let waited = 0; waited < 50 && leftIn(home).length > 0; waited += 1) {
      await Bun.sleep(100);
    }
  }

  rmSync(home, { recursive: true, force: true });
  delete process.env.XDG_STATE_HOME;
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
      "export HEX_DIR=",
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

const DOOR_THAT_SAYS_IT_STARTED = `import { appendFileSync } from 'fs'
appendFileSync(process.argv[2] + '/doors', process.pid + '\\n')
setInterval(() => {}, 1000)
`;

const doors = () =>
  existsSync(join(home, "state/doors"))
    ? readFileSync(join(home, "state/doors"), "utf-8").trim().split("\n").map(Number)
    : [];

const alive = (pid = 0) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

test("iikb's door starts with hex, stays up through the hub's restarts, gives way only to a door whose file or port changed, and stops with hex", async () => {
  const door = join(hex, "channels/iikb/door.ts");
  mkdirSync(join(hex, "channels/iikb"), { recursive: true });
  writeFileSync(door, DOOR_THAT_SAYS_IT_STARTED);
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const running = run();
  await until(() => hubs().length === 1 && doors().length === 1);
  Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
  await until(() => hubs().length === 3);
  await Bun.sleep(300);
  expect(doors()).toHaveLength(1);
  expect(alive(doors()[0])).toBe(true);
  writeFileSync(door, `${DOOR_THAT_SAYS_IT_STARTED}\n`);
  Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
  await until(() => hubs().length === 5 && doors().length === 2);
  expect(alive(doors()[0])).toBe(false);
  expect(alive(doors()[1])).toBe(true);
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nIIKB_PORT=2600\n");
  Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
  await until(() => hubs().length === 7 && doors().length === 3);
  expect(alive(doors()[1])).toBe(false);
  running.kill("SIGTERM");
  expect(await running.exited).toBe(0);
  await until(() => !alive(doors()[2]));
});

test("a restart that finds hex moved to another machine stops the door with hex", async () => {
  const moved = join(home, "moved");
  mkdirSync(join(hex, "channels/iikb"), { recursive: true });
  writeFileSync(join(hex, "channels/iikb/door.ts"), DOOR_THAT_SAYS_IT_STARTED);
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const running = run({ XDG_STATE_HOME: moved });
  await until(() => hubs().length === 1 && doors().length === 1);
  mkdirSync(join(moved, "hex"), { recursive: true });
  writeFileSync(join(moved, "hex/elsewhere"), "another-machine\n");
  Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
  expect(await running.exited).toBe(1);
  await until(() => !alive(doors()[0]));
});

test("a restart where no hub runs starts none, so a machine that doesn't hold hex, like a standby twin, stays without one", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const restart = Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
  expect(restart.exitCode).toBe(0);
  expect(restart.stderr.toString()).toContain("hex isn't running here");
  await Bun.sleep(1000);
  expect(hubs()).toEqual([]);
});

test("the hub gets the env of the settings files over .env, so a setting changes without touching .env", async () => {
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { MARK: "settings" } }));
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  run();
  await until(() => hubs().length === 1);
  expect(hubs()[0]).toMatch(/^start mark=settings loop=1 \d+$/u);
});

test("hex started ahead of its turn starts its hub at once, which waits itself, and takes over the rest once the file HEX_AHEAD names is gone", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  const ahead = join(home, "ahead");
  writeFileSync(ahead, "");
  run({ HEX_AHEAD: ahead });
  await until(() => hubs().length === 1);
  await Bun.sleep(500);
  expect(existsSync(join(home, "state/hub.pid"))).toBe(false);
  expect(existsSync(join(home, "state/hex.bell"))).toBe(false);
  rmSync(ahead);
  await until(() => existsSync(join(home, "state/hub.pid")));
  expect(hubs()).toHaveLength(1);
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
  expect(existsSync(join(home, "state/refused"))).toBe(false);
  expect(readFileSync(join(home, "state/rollback"), "utf-8")).toContain(
    `hex ${bad.slice(0, 7)} ("a hub that crashes") couldn't start`,
  );
  const update = Bun.spawnSync([join(hex, "bin/update")]);
  expect(update.exitCode).toBe(1);
  expect(update.stdout.toString()).toContain(
    `not updated: hex went back from ${bad.slice(0, 7)}, or from a commit`,
  );
  expect(git("rev-parse", "HEAD")).toBe(good);
});

const generalConnects = (hub: string) =>
  `${hub}\nsetTimeout(() => require('fs').writeFileSync(process.env.HEX_DIR + '/state/good', Bun.spawnSync(['git', '-C', import.meta.dir + '/..', 'rev-parse', 'HEAD']).stdout.toString()), 300)\n`;

const goodIs = (sha: string) =>
  existsSync(join(home, "state/good")) &&
  readFileSync(join(home, "state/good"), "utf-8") === `${sha}\n`;

const named = (hub: string, name: string) => `${hub}export const name = ${JSON.stringify(name)}\n`;

const GENERAL_CONNECTS = generalConnects(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS);

const rollback = (to: string, env: Record<string, string> = {}) =>
  Bun.spawnSync([join(hex, "bin/hex"), "rollback", to], { env: { ...process.env, ...env } });

const isRefused = (sha: string) =>
  Bun.spawnSync([join(hex, "bin/hex"), "refused", sha]).exitCode === 0;

const asked = (...args: string[]) => Bun.spawn(args, { stdout: "pipe" });

const withOrigin = () => {
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(home, "origin")]);
  git("remote", "add", "origin", join(home, "origin"));
  git("push", "-q", "origin", "main");
};

test("hex rollback says hex went back only once a hub runs the earlier commit, and bin/update takes neither a commit hex went back from nor what main had built on it, until main moves past them", async () => {
  const older = commit(named(GENERAL_CONNECTS, "an older hub"), "an older hub");
  const before = commit(named(GENERAL_CONNECTS, "a hub"), "a hub");

  const ship = commit(
    named(GENERAL_CONNECTS.replace("'start mark='", "'ship mark='"), "a ship"),
    "a ship",
  );

  const onTop = commit(
    named(GENERAL_CONNECTS.replace("'start mark='", "'ship mark='"), "built on the ship"),
    "built on the ship",
  );

  withOrigin();
  git("reset", "-q", "--hard", ship);
  run();
  await until(() => goodIs(ship));

  const rolled = rollback(before.slice(0, 7));
  expect(rolled.stdout.toString()).toBe(
    `hex is back on ${before.slice(0, 7)} ("a hub"): a hub runs it, and General connected to it.\n`,
  );
  expect(rolled.exitCode).toBe(0);
  const [shipped, stopped, back] = hubs();
  expect(shipped).toMatch(/^ship mark=1 /u);
  expect(stopped).toBe(`stop ${shipped?.split(" ").at(-1)}`);
  expect(back).toMatch(/^start mark=1 loop=1 \d+$/u);
  expect(git("rev-parse", "HEAD")).toBe(before);

  expect(readFileSync(join(home, "state/rollback"), "utf-8")).toContain(
    `hex went back from ${ship.slice(0, 7)} ("a ship") to ${before.slice(0, 7)} ("a hub") by \`hex rollback\``,
  );

  const update = Bun.spawnSync([join(hex, "bin/update")]);
  expect(update.exitCode).toBe(1);
  expect(update.stdout.toString()).toContain(
    `not updated: hex went back from ${onTop.slice(0, 7)}`,
  );
  expect([ship, onTop, before, older].map(isRefused)).toEqual([true, true, false, false]);

  expect(rollback(older).exitCode).toBe(0);
  expect([ship, onTop, before, older].map(isRefused)).toEqual([true, true, true, false]);
  expect(git("rev-parse", "HEAD")).toBe(older);
  expect(Bun.spawnSync([join(hex, "bin/update"), "--now"]).exitCode).toBe(1);
  expect(git("rev-parse", "HEAD")).toBe(older);

  git("reset", "-q", "--hard", onTop);
  const past = commit(named(GENERAL_CONNECTS, "a revert of the ship"), "a revert of the ship");
  git("reset", "-q", "--hard", older);
  expect(isRefused(past)).toBe(false);
});

test("a rollback whose old hub won't stop says so, and run again once it has, finishes", async () => {
  const before = commit(named(GENERAL_CONNECTS, "a hub"), "a hub");

  const deaf = commit(
    generalConnects("process.on('SIGHUP', () => {})\nsetInterval(() => {}, 1000)\n"),
    "a ship whose hub won't stop",
  );

  run();
  await until(() => goodIs(deaf));

  const stuck = Bun.spawnSync(["pgrep", "-f", join(hex, "hub/serve.ts")])
    .stdout.toString()
    .trim();

  const first = rollback(before, { HEX_ROLLBACK_WAIT: "2" });
  expect(first.exitCode).toBe(1);
  expect(first.stdout.toString()).toBe("");
  expect(first.stderr.toString()).toContain(`the hub from before (pid ${stuck}) hasn't stopped`);
  expect(git("rev-parse", "HEAD")).toBe(before);

  process.kill(Number(stuck), "SIGKILL");
  const again = rollback(before);
  expect(again.stdout.toString()).toMatch(/^hex (is back on|is on) /u);
  expect(again.exitCode).toBe(0);
  expect(hubs().at(-1)).toMatch(/^start mark=1 loop=1 \d+$/u);
});

test("a rollback across a change to hex's units links them and restarts hex.service, and run again after a link that failed, finishes", async () => {
  mkdirSync(join(hex, "systemd"));
  writeFileSync(join(hex, "services.json"), '{ "units": [] }\n');
  writeFileSync(join(hex, "systemd/hex.service"), "[Service]\n");
  const before = commit(named(GENERAL_CONNECTS, "a hub"), "a hub");
  writeFileSync(join(hex, "systemd/hex.service"), "[Service]\nMemoryMax=1G\n");

  const ship = commit(
    named(GENERAL_CONNECTS, "a ship that changes hex.service"),
    "a ship that changes hex.service",
  );

  run();
  await until(() => goodIs(ship));

  const fake = join(home, "fake-bin");
  mkdirSync(fake);
  writeFileSync(
    join(fake, "systemctl"),
    `#!/bin/sh
echo "$*" >> "${home}/systemctl"
case "$*" in
  *FragmentPath*) echo "${hex}/systemd/hex.service" ;;
  *daemon-reload*) [ ! -e "${home}/reload-fails" ] || exit 1 ;;
  *"restart --no-block hex.service"*) pkill -HUP -P "$(cat "${home}/state/hub.pid")" -f hub/serve.ts ;;
esac
`,
    { mode: 0o755 },
  );
  const PATH = `${fake}:${process.env.PATH}`;
  writeFileSync(join(home, "reload-fails"), "");
  expect(rollback(before, { PATH }).exitCode).not.toBe(0);
  expect(git("rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(home, "systemctl"), "utf-8")).not.toContain(
    "restart --no-block hex.service",
  );

  rmSync(join(home, "reload-fails"));
  const again = rollback(before, { PATH });
  expect(again.stdout.toString()).toStartWith(`hex is back on ${before.slice(0, 7)}`);
  expect(readFileSync(join(home, "systemctl"), "utf-8")).toContain(
    "--user restart --no-block hex.service",
  );
});

test("when the commit hex went back to can't start, hex stays down and says so, and never goes forward to one it went back from", async () => {
  const crashing = commit("process.exit(1)\n", "a hub that can't start");
  const ship = commit(named(GENERAL_CONNECTS, "a ship"), "a ship");
  const running = run();
  await until(() => goodIs(ship));

  const rolled = rollback(crashing, { HEX_ROLLBACK_WAIT: "20" });
  expect(rolled.exitCode).toBe(1);
  expect(rolled.stderr.toString()).toContain("no hub is up on it: none stays up");
  expect(await running.exited).toBe(1);
  expect(await new Response(running.stderr).text()).toContain(
    "there's no earlier hex to go back to",
  );
  expect(git("rev-parse", "HEAD")).toBe(crashing);
  expect(isRefused(ship)).toBe(true);

  writeFileSync(join(home, "state/good"), `${ship}\n`);
  expect(await run().exited).toBe(1);
  expect(git("rev-parse", "HEAD")).toBe(crashing);
});

test("a machine that takes hex over refuses what the store says another machine went back from, fetching a newest commit it hasn't seen", async () => {
  const before = commit(named(GENERAL_CONNECTS, "a hub"), "a hub");
  const ship = commit(named(GENERAL_CONNECTS, "a ship"), "a ship");
  withOrigin();
  const elsewhere = join(home, "elsewhere");
  Bun.spawnSync(["git", "clone", "-q", join(home, "origin"), elsewhere]);
  writeFileSync(join(elsewhere, "on-top"), "");
  Bun.spawnSync(["git", "-C", elsewhere, "add", "-A"]);
  Bun.spawnSync([
    "git",
    "-C",
    elsewhere,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "merged on top",
  ]);
  Bun.spawnSync(["git", "-C", elsewhere, "push", "-q", "origin", "main"]);

  const onTop = Bun.spawnSync(["git", "-C", elsewhere, "rev-parse", "HEAD"])
    .stdout.toString()
    .trim();

  expect(Bun.spawnSync(["git", "-C", hex, "cat-file", "-e", onTop]).exitCode).not.toBe(0);

  const store = Bun.serve({
    port: 0,
    fetch: () => Response.json({ version: "v", hub: before, refused: [`${onTop} ${before}`] }),
  });

  try {
    writeFileSync(
      join(home, "state/store.json"),
      JSON.stringify({ url: store.url.origin, name: "hex", key: "k".repeat(40) }),
    );
    expect(await asked(join(hex, "bin/hex"), "refused", ship).exited).toBe(0);
    expect(await asked(join(hex, "bin/hex"), "refused", before).exited).toBe(1);
    git("reset", "-q", "--hard", before);
    const update = asked(join(hex, "bin/update"));
    expect(await new Response(update.stdout).text()).toContain(
      `not updated: hex went back from ${onTop.slice(0, 7)}`,
    );
    expect(git("rev-parse", "HEAD")).toBe(before);
  } finally {
    await store.stop(true);
  }
});

test("an update that asked before a rollback asks again just before it merges, so it never takes hex forward past one", async () => {
  writeFileSync(join(hex, "bin/check"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(
    join(hex, "bin/quiet"),
    `#!/bin/sh\ntouch "${home}/waiting"\nwhile [ ! -e "${home}/go" ]; do sleep 0.1; done\n`,
    { mode: 0o755 },
  );
  const before = commit(named(GENERAL_CONNECTS, "a hub"), "a hub");
  const ship = commit(named(GENERAL_CONNECTS, "a ship"), "a ship");
  const onTop = commit(named(GENERAL_CONNECTS, "merged on top"), "merged on top");
  withOrigin();
  git("reset", "-q", "--hard", ship);
  run();
  await until(() => goodIs(ship));

  const update = Bun.spawn([join(hex, "bin/update")], {
    env: { ...process.env, XDG_CACHE_HOME: join(home, "cache") },
    stdout: "pipe",
  });

  await until(() => existsSync(join(home, "waiting")));
  expect(rollback(before).exitCode).toBe(0);
  writeFileSync(join(home, "go"), "");
  expect(await update.exited).toBe(1);
  expect(await new Response(update.stdout).text()).toContain(
    `not updated: hex went back from ${onTop.slice(0, 7)}`,
  );
  expect(git("rev-parse", "HEAD")).toBe(before);
});

test("a rollback that can't write what it refuses doesn't go back, so hex never goes back with nothing refused", async () => {
  const before = commit(named(GENERAL_CONNECTS, "a hub"), "a hub");
  const ship = commit(named(GENERAL_CONNECTS, "a ship"), "a ship");
  run();
  await until(() => goodIs(ship));
  mkdirSync(join(home, "state/refused"));
  expect(rollback(before).exitCode).toBe(1);
  expect(git("rev-parse", "HEAD")).toBe(ship);
  expect(goodIs(ship)).toBe(true);
  expect(existsSync(join(home, "state/bad"))).toBe(false);
});

test("hex rollback goes back only to a commit hex is built on, keeps changes made in its folder, and runs where hex runs", () => {
  const before = commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  git("checkout", "-q", "-b", "side");
  const side = commit("process.exit(1)\n", "a commit hex isn't built on");
  git("checkout", "-q", "main");
  const ship = commit("process.exit(2)\n", "a ship");

  const usage = Bun.spawnSync([join(hex, "bin/hex"), "rollback"]);
  expect(usage.exitCode).toBe(2);
  expect(usage.stderr.toString()).toStartWith("usage: hex rollback <commit>");
  expect(rollback("nosuch").stderr.toString()).toBe(
    "hex rollback: hex has no commit nosuch here\n",
  );
  expect(rollback(ship).stderr.toString()).toContain(
    "hex isn't running here, so nothing restarted",
  );
  expect(rollback(side).stderr.toString()).toContain("isn't one");

  writeFileSync(join(hex, "hub/serve.ts"), "an edit nobody committed\n");
  expect(rollback(before).exitCode).toBe(1);
  expect(readFileSync(join(hex, "hub/serve.ts"), "utf-8")).toBe("an edit nobody committed\n");
  expect(git("rev-parse", "HEAD")).toBe(ship);
  expect(existsSync(join(home, "state/bad"))).toBe(false);
  expect(readFileSync(join(home, "state/refused"), "utf-8")).toBe("");
  git("checkout", "--", "hub/serve.ts");

  const fake = join(home, "fake-bin");
  mkdirSync(fake);
  writeFileSync(
    join(fake, "ssh"),
    `#!/bin/sh\nfor last; do :; done\necho "$last" > "${home}/ssh"\n`,
    {
      mode: 0o755,
    },
  );
  mkdirSync(join(home, "xdg-state/hex"), { recursive: true });
  writeFileSync(join(home, "xdg-state/hex/elsewhere"), "the-other-machine\n");
  expect(rollback(before, { PATH: `${fake}:${process.env.PATH}` }).exitCode).toBe(0);
  const sent = /printf %s (\S+) \| base64 -d/u.exec(readFileSync(join(home, "ssh"), "utf-8"))?.[1];

  const there = Buffer.from(sent ?? "", "base64")
    .toString()
    .split("\0");

  expect(there.slice(there.indexOf(join(hex, "bin/hex")))).toEqual([
    join(hex, "bin/hex"),
    "rollback",
    before,
    "",
  ]);
  expect(git("rev-parse", "HEAD")).toBe(ship);
});

test("a hub that keeps exiting while the store holding its records doesn't answer isn't taken for a bad commit: hex stays on it and keeps starting the hub", async () => {
  const good = commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(join(home, "state/good"), `${good}\n`);

  const crashing = commit(
    `import { appendFileSync } from 'fs'\nappendFileSync(process.env.HEX_DIR + '/state/hubs', 'start\\n')\nprocess.exit(1)\n`,
    "a hub that exits while its store is down",
  );

  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = gone.url.origin;
  await gone.stop(true);

  writeFileSync(
    join(home, "state/store.json"),
    JSON.stringify({ url, name: "hex", key: "k".repeat(40) }),
  );
  const running = run();
  await until(() => hubs().length >= 4);
  running.kill("SIGTERM");
  await running.exited;
  expect(git("rev-parse", "HEAD")).toBe(crashing);
  expect(existsSync(join(home, "state/bad"))).toBe(false);
  expect(await new Response(running.stderr).text()).toContain(
    `can't reach its records at ${url}: its hub keeps starting again, on the same commit`,
  );
});

test("a hub that lost hex to another machine stays stopped: hex exits with its code, which hex.service doesn't restart, and isn't taken for a bad commit", async () => {
  const good = commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(join(home, "state/good"), `${good}\n`);

  const lost = commit(
    `import { appendFileSync } from 'fs'\nappendFileSync(process.env.HEX_DIR + '/state/hubs', 'start lease=' + process.env.HEX_STORE_LEASE + '\\n')\nprocess.exit(3)\n`,
    "a hub another machine took hex from",
  );

  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nHEX_MAIN_THREAD=-100\n");
  const { PATH, read } = curlThatRecordsWhatGeneralIsTold();

  const running = run({ HEX_STORE_LEASE: "7", PATH });
  expect(await running.exited).toBe(3);
  expect(await new Response(running.stderr).text()).toContain(
    "its store gave hex to another hub, so it stays stopped here",
  );
  expect(read()).toContain("chat_id=-100");
  expect(read()).toContain("its store gave hex to another hub");
  expect(hubs()).toEqual(["start lease=7"]);
  expect(git("rev-parse", "HEAD")).toBe(lost);
  expect(existsSync(join(home, "state/bad"))).toBe(false);
  expect(existsSync(join(home, "state/hub.pid"))).toBe(false);
  expect(readFileSync(join(BIN, "../systemd/hex.service"), "utf-8")).toMatch(
    /^RestartPreventExitStatus=3$/mu,
  );

  for (const lease of [{}, { HEX_STORE_LEASE: "7" }]) {
    const restartedByASupervisor = run({ PATH, ...lease });
    expect(await restartedByASupervisor.exited).toBe(3);
  }

  expect(hubs()).toHaveLength(1);
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub again");

  const givenHexBackOnANewerLease = run({ PATH, HEX_STORE_LEASE: "8" });
  await until(() => hubs().length === 2);
  givenHexBackOnANewerLease.kill("SIGTERM");
  expect(await givenHexBackOnANewerLease.exited).toBe(0);
  expect(existsSync(join(home, "state/lost"))).toBe(false);

  writeFileSync(join(home, "state/lost"), "9\nhex stopped here\n");
  expect(Bun.spawnSync([join(hex, "bin/hex"), "start"]).exitCode).toBe(0);
  await until(() => existsSync(join(home, "state/hub.pid")) && hubs().length === 4);
  expect(hubs()[3]).toStartWith("start ");
  expect(await Bun.spawn([join(hex, "bin/hex"), "stop"]).exited).toBe(0);
});

test("a machine hex was lost on pays what its hubs owed to the store, though no hub starts there", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(
    join(hex, "hub/paid.ts"),
    `import { appendFileSync } from 'fs'\nappendFileSync(process.argv[2] + '/hubs', 'paid\\n')\n`,
  );
  writeFileSync(join(home, "state/lost"), "7\nhex stopped here\n");

  expect(await run().exited).toBe(3);
  expect(hubs()).toEqual([]);

  writeFileSync(join(home, "state/owed.telegram.json"), "");
  expect(await run().exited).toBe(3);
  expect(hubs()).toEqual(["paid"]);
});

test("a HEX_STORE_LEASE that isn't a whole number stops hex as failed before any hub starts, and says so", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");

  const running = run({ HEX_STORE_LEASE: "7x" });
  expect(await running.exited).toBe(1);
  expect(await new Response(running.stderr).text()).toContain(
    "HEX_STORE_LEASE is 7x, not a whole number",
  );
  expect(hubs()).toEqual([]);
});

test("a restart in place starts the hub again even when the login shell leaves something behind", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");

  const shell = join(home, "shell-that-leaves-a-sleep");
  writeFileSync(
    shell,
    `#!/bin/sh\nsleep 20 >/dev/null 2>&1 &\necho $! >> "${home}/strays"\necho\necho hex-path\nenv\n`,
    { mode: 0o755 },
  );

  try {
    run({ SHELL: shell });
    await until(() => hubs().length === 1);
    Bun.spawnSync([join(hex, "bin/hex"), "restart"]);
    await until(() => hubs().length === 3);
    expect(hubs()[2]).toMatch(/^start mark=1 loop=1 \d+$/u);
  } finally {
    Bun.spawnSync(["kill", ...readFileSync(join(home, "strays"), "utf-8").trim().split("\n")]);
  }
});

test("hex without flock says so and stops as failed", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");

  const tools = join(home, "tools");
  mkdirSync(tools);

  const linked = new Set(["flock"]);

  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const tool of existsSync(dir) ? readdirSync(dir) : []) {
      if (!linked.has(tool)) {
        linked.add(tool);
        symlinkSync(join(dir, tool), join(tools, tool));
      }
    }
  }

  const shell = join(home, "shell-as-it-is");
  writeFileSync(shell, "#!/bin/sh\necho\necho hex-path\nenv\n", { mode: 0o755 });

  const running = run({ PATH: tools, SHELL: shell });
  expect(await running.exited).toBe(1);
  expect(await new Response(running.stderr).text()).toContain("flock isn't installed");
  expect(hubs()).toEqual([]);
});

test("a second hex on a folder one already runs leaves it be", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  run();
  await until(() => hubs().length === 1);

  const second = Bun.spawnSync([join(hex, "bin/hex"), "run"]);
  expect(second.exitCode).toBe(0);
  expect(second.stderr.toString()).toContain("hex runs here already");
  await Bun.sleep(500);
  expect(hubs()).toHaveLength(1);
});

test("where hex.service runs this folder's hex, a stop and a start go through it, so systemd neither brings hex back nor runs a second", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");

  const fakes = join(home, "systemd-bin");
  mkdirSync(fakes);
  writeFileSync(
    join(fakes, "systemctl"),
    `#!/bin/sh\ncase "$*" in\n  "--user show-environment") ;;\n  "--user show -p ExecStart --value hex.service") echo "{ path=${hex}/bin/hex ; argv[]=${hex}/bin/hex run ; }" ;;\n  *) echo "$*" >> "${home}/systemctl" ;;\nesac\n`,
    { mode: 0o755 },
  );

  const env = { ...process.env, PATH: `${fakes}:${process.env.PATH}` };

  const told = () =>
    existsSync(join(home, "systemctl")) ? readFileSync(join(home, "systemctl"), "utf-8") : "";

  expect(Bun.spawnSync([join(hex, "bin/hex"), "start"], { env }).exitCode).toBe(0);
  expect(told()).toBe("--user start --no-block hex.service\n");
  await Bun.sleep(500);
  expect(hubs()).toEqual([]);

  const byHand = run();
  await until(() => existsSync(join(home, "state/hub.pid")));
  expect(await Bun.spawn([join(hex, "bin/hex"), "stop"], { env }).exited).toBe(0);
  expect(told()).toContain("--user stop hex.service");
  expect(await byHand.exited).toBe(0);
});

const MOVE_THAT_RUNS_UNTIL_TOLD = `import { appendFileSync, existsSync } from 'fs'
const [state] = process.argv.slice(2)
appendFileSync(state + '/hubs', 'moving\\n')
const giveUp = Date.now() + 60_000
while (!existsSync(state + '/moved') && Date.now() < giveUp) await Bun.sleep(20)
appendFileSync(state + '/hubs', 'moved\\n')
`;

test("no hub starts on records that are moving, however hex starts, and no move starts while hex runs here", async () => {
  commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  mkdirSync(join(hex, "hub/store"));
  writeFileSync(join(hex, "hub/store/move.ts"), MOVE_THAT_RUNS_UNTIL_TOLD);

  const move = Bun.spawn([join(hex, "bin/hex"), "store", "move", "https://store.example", "hex"], {
    stderr: "pipe",
  });

  await until(() => hubs().length === 1);

  const waiting = run();
  await Bun.sleep(1500);
  expect(hubs()).toEqual(["moving"]);
  waiting.kill("SIGTERM");
  expect(await waiting.exited).toBe(0);

  run();
  await Bun.sleep(500);
  writeFileSync(join(home, "state/moved"), "");
  expect(await move.exited).toBe(0);
  await until(() => hubs().length === 3);
  expect(hubs()[2]).toMatch(/^start mark=1 loop=1 \d+$/u);

  const refused = Bun.spawnSync([
    join(hex, "bin/hex"),
    "store",
    "move",
    "https://store.example",
    "hex",
  ]);

  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("hex is running here: stop it first");
  expect(hubs()).toHaveLength(3);
});

test("on a store that answers, a commit whose hub can't start goes back to the last good one and runs there, with nobody at the machine", async () => {
  const good = commit(HUB_THAT_WAITS_OUT_A_CALL_AS_IT_STOPS, "a hub");
  writeFileSync(join(home, "state/good"), `${good}\n`);

  const bad = commit("process.exit(1)\n", "a hub that crashes on a store it's newer than");

  const store = Bun.serve({
    port: 0,
    fetch: () => Response.json({ version: "a newer store", migrations: 50, contract: "newer" }),
  });

  try {
    writeFileSync(
      join(home, "state/store.json"),
      JSON.stringify({ url: store.url.origin, name: "hex", key: "k".repeat(40) }),
    );

    run();
    await until(() => hubs().length === 1);
    expect(git("rev-parse", "HEAD")).toBe(good);
    expect(readFileSync(join(home, "state/bad"), "utf-8").trim()).toBe(bad);
    expect(hubs()[0]).toMatch(/^start mark=1 loop=1 \d+$/u);
  } finally {
    await store.stop(true);
  }
});

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
});
