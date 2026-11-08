import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEX = join(import.meta.dir, "../..");
const home = mkdtempSync(join(tmpdir(), "place-"));
const fake = join(home, "fake");
const here = Bun.spawnSync(["uname", "-n"]).stdout.toString().trim();
const slots = join(home, "state/hex/slots");
const AWAY_EXIT_WHEN_THE_JOB_CANT_RUN_THERE = 76;

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

beforeAll(() => {
  mkdirSync(join(home, ".hex/bin"), { recursive: true });
  mkdirSync(fake);

  for (const file of ["bin/place", "bin/settings"]) {
    cpSync(join(HEX, file), join(home, ".hex", file));
  }

  script(join(home, ".hex/bin/room"), `cat "${fake}/${here}"; exit $(cat "${fake}/${here}.code")`);
  script(join(home, ".hex/bin/session"), `echo "session $* $(cat)"`);
  script(
    join(home, ".hex/bin/away"),
    `echo "away $* $(cat)"; exit $(cat "${fake}/$1.away" 2>/dev/null || echo 0)`,
  );
  script(join(home, ".hex/bin/job"), `echo "$*" >> "${fake}/told"`);
  script(join(fake, "bun"), 'exec "$@"');
  script(join(fake, "ssh"), `cat "${fake}/$3"; exit $(cat "${fake}/$3.code")`);
  mkdirSync(join(home, ".claude"));
});

afterAll(() => {
  rmSync(home, { recursive: true });
});

function machine(name: string, reading: string, code: number, awayExit?: number) {
  writeFileSync(join(fake, name), reading ? `${reading}\n` : "");
  writeFileSync(join(fake, `${name}.code`), `${code}`);

  if (awayExit === undefined) {
    rmSync(join(fake, `${name}.away`), { force: true });
  } else {
    writeFileSync(join(fake, `${name}.away`), `${awayExit}`);
  }
}

function place(settings: Record<string, string> = {}, wait = 10_000) {
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: settings }));
  rmSync(join(fake, "told"), { force: true });

  const ran = Bun.spawnSync(
    ["timeout", `${wait / 1000}`, join(home, ".hex/bin/place"), "hex/deck", "-p", "build it"],
    {
      cwd: home,
      stdin: Buffer.from("the log"),
      env: {
        ...process.env,
        PATH: `${fake}:${process.env.PATH}`,
        XDG_STATE_HOME: join(home, "state"),
        HEX_OWNER: "telegram:-100123:908",
      },
    },
  );

  return {
    out: ran.stdout.toString(),
    code: ran.exitCode,
    told: existsSync(join(fake, "told")) ? readFileSync(join(fake, "told"), "utf-8") : "",
  };
}

test("a job runs here as a hex session while this machine has room, with what came on its stdin", () => {
  machine(here, "cpu 3% busy", 0);
  expect(place({ HEX_MACHINES: "mac:3" }).out).toBe(
    `hex/deck runs on ${here}\nsession -n hex/deck -p build it the log\n`,
  );
});

test("a job goes to the next machine with room, as a T3 Code thread on that machine's hex T3", () => {
  machine(here, "cpu 80% busy", 1);
  machine("mac", "cpu 20% busy\nt3 env-mac", 0);
  expect(place({ HEX_MACHINES: "mac:3" }).out).toBe(
    "hex/deck runs on mac\naway mac env-mac hex/deck -p build it the log\n",
  );
});

test("held slots, a machine without a hex T3 Code, and one where the job could not run are passed over, and the next machine gets all of its stdin", () => {
  machine(here, "cpu 3% busy", 0);
  machine("cloud", "cpu 1% busy", 0);
  machine("mini", "cpu 1% busy\nt3 env-mini", 0, AWAY_EXIT_WHEN_THE_JOB_CANT_RUN_THERE);
  machine("mac", "cpu 20% busy\nt3 env-mac", 0);
  mkdirSync(slots, { recursive: true });
  const held = Bun.spawn(["flock", "-o", join(slots, `${here}.1`), "sleep", "30"]);
  Bun.sleepSync(200);
  const { out, code } = place({ HEX_SLOTS: "1", HEX_MACHINES: "cloud:1 mini mac:3" });
  held.kill();
  expect(out).toBe(
    "hex/deck runs on mini\naway mini env-mini hex/deck -p build it the log\nhex/deck runs on mac\naway mac env-mac hex/deck -p build it the log\n",
  );
  expect(code).toBe(0);
});

test("a machine whose T3 Code doesn't answer is passed over for that round only", () => {
  machine(here, "cpu 80% busy", 1);
  machine("mini", "cpu 1% busy\nt3 env-mini", 0, 77);
  machine("mac", "cpu 20% busy\nt3 env-mac", 0);
  expect(place({ HEX_MACHINES: "mini:1 mac:3" }).out).toBe(
    "hex/deck runs on mini\naway mini env-mini hex/deck -p build it the log\nhex/deck runs on mac\naway mac env-mac hex/deck -p build it the log\n",
  );
});

test("with no room anywhere a job waits, and its owner hears it once, with every reading", () => {
  machine(here, "cpu 80% busy", 1);
  machine("mac", "", 255);
  const { out, told } = place({ HEX_MACHINES: "mac:3" }, 3000);
  expect(out).toBe(`hex/deck waits for room:\n${here}: cpu 80% busy\nmac: no answer\n`);
  expect(told).toBe(
    `--waiting deck telegram:-100123:908 \n${here}: cpu 80% busy\nmac: no answer\n`,
  );
});

test("a job behind another in line waits its turn without telling its owner", () => {
  machine(here, "cpu 3% busy", 0);
  mkdirSync(slots, { recursive: true });
  const ahead = Bun.spawn(["flock", "-o", join(slots, "line"), "sleep", "30"]);
  Bun.sleepSync(200);
  const { told } = place({}, 2000);
  ahead.kill();
  expect(told).toBe("");
});

test("a stopped job keeps its slot until it has stopped, as systemd's stop reaches every process at once", async () => {
  machine(here, "cpu 3% busy", 0);
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { HEX_SLOTS: "1" } }));
  const session = join(home, ".hex/bin/session");
  const kept = readFileSync(session, "utf-8");
  script(
    session,
    `trap 'sleep 2; echo stopped >> "${fake}/stops"; exit 143' TERM; echo started > "${fake}/started"; sleep 30 & wait`,
  );

  const unit = Bun.spawn(["setsid", join(home, ".hex/bin/place"), "hex/deck", "-p", "build it"], {
    cwd: home,
    stdin: Buffer.from(""),
    env: {
      ...process.env,
      PATH: `${fake}:${process.env.PATH}`,
      XDG_STATE_HOME: join(home, "state"),
    },
  });

  while (!existsSync(join(fake, "started"))) {
    await Bun.sleep(50);
  }

  process.kill(-unit.pid, "SIGTERM");
  await Bun.sleep(500);
  expect(Bun.spawnSync(["flock", "-n", join(slots, `${here}.1`), "true"]).exitCode).toBe(1);
  expect(await unit.exited).toBe(143);
  expect(readFileSync(join(fake, "stops"), "utf-8")).toBe("stopped\n");
  expect(Bun.spawnSync(["flock", "-n", join(slots, `${here}.1`), "true"]).exitCode).toBe(0);
  writeFileSync(session, kept);
  rmSync(join(fake, "started"));
}, 20_000);
