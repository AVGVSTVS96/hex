import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vault-"));
  mkdirSync(join(home, ".hex/bin"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, "fake"));

  for (const script of ["vault", "settings"]) {
    copyFileSync(join(import.meta.dir, "../../bin", script), join(home, ".hex/bin", script));
  }

  writeFileSync(
    join(home, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=bot-secret",
      "export TRANSCRIBE_URL=http://transcribe",
      "TRANSCRIBE_MODEL=a SPEECH_KEY=speech-secret",
      "readonly TELEGRAM_BOT_TOKEN",
      'echo "export PRINTED=1"',
      `ENCLAVE_HOME='/vault home/it'\\''s $x'`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({ env: { HEX_NAME: "herald", HEX_COMPUTER: "box" } }),
  );
  fake(
    "enclave",
    '[ "$1" = --version ] && echo 0.2.12 && exit\n[ "$1" = get ] && printf hunter2 && exit\nenv',
  );
  fake("sprite", `cat > ${join(home, "typed")}`);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fake(name: string, body: string) {
  writeFileSync(join(home, "fake", name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(home, "fake", name), 0o755);
}

function vault(args: string[], caller: Record<string, string> = {}) {
  const env = { PATH: `${join(home, "fake")}:${process.env.PATH}`, HOME: home, ...caller };
  const run = Bun.spawnSync([join(home, ".hex/bin/vault"), ...args], { env });

  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

test("vault run hands the command its caller's environment and enclave's settings, and none of .env", () => {
  const { code, out, err } = vault(["run", "GitHub", "--", "env"], { LANG: "C.UTF-8" });
  expect({ code, err }).toEqual({ code: 0, err: "export PRINTED=1\n" });
  expect(out).toContain("ENCLAVE_FROM=herald\n");
  expect(out).toContain("ENCLAVE_HOME=/vault home/it's $x\n");
  expect(out).toContain("LANG=C.UTF-8\n");

  for (const kept of ["bot-secret", "speech-secret", "TRANSCRIBE_URL", "HEX_COMPUTER", "PRINTED"]) {
    expect(out).not.toContain(kept);
  }
});

test("vault run keeps a setting exactly", () => {
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({ env: { HEX_NAME: "herald", ENCLAVE_RELAY: "https://relay`$(id)`\n" } }),
  );
  appendFileSync(join(home, ".env"), "ENCLAVE_HOME=$(printf '/v\\377\\303')\n");

  const run = Bun.spawnSync([join(home, ".hex/bin/vault"), "run", "GitHub", "--", "env"], {
    env: { PATH: `${join(home, "fake")}:${process.env.PATH}`, LANG: "en_US.UTF-8" },
  });

  const out = Buffer.from(run.stdout);
  expect(out.includes(Buffer.from("ENCLAVE_RELAY=https://relay`$(id)`\n\n"))).toBe(true);
  expect(out.includes(Buffer.from([...Buffer.from("ENCLAVE_HOME=/v"), 0o377, 0o303, 10]))).toBe(
    true,
  );
});

test("vault run works without a .env", () => {
  rmSync(join(home, ".env"));
  expect(vault(["run", "GitHub", "--", "env"]).out).toContain("ENCLAVE_FROM=herald\n");
});

test("vault run through bunx gets none of .env either", () => {
  rmSync(join(home, "fake/enclave"));
  fake("bunx", "env");

  const { out } = vault(["run", "GitHub", "--", "env"], {
    PATH: `${join(home, "fake")}:/usr/bin:/bin`,
  });

  expect(out).toContain("ENCLAVE_FROM=herald\n");
  expect(out).not.toContain("bot-secret");
});

test("vault run stops on settings it can't read", () => {
  writeFileSync(join(home, ".claude/settings.json"), "");
  expect(vault(["run", "GitHub", "--", "env"])).toEqual({
    code: 1,
    out: "",
    err: "export PRINTED=1\nhex couldn't read its settings\n",
  });
});

test("vault run stops on a .env that doesn't parse", () => {
  appendFileSync(join(home, ".env"), 'BROKEN="unclosed\n');
  const { code, out } = vault(["run", "GitHub", "--", "env"]);
  expect(code).not.toBe(0);
  expect(out).toBe("");
});

test.each(["exit 0", "false", "X=$(false)", ". ./missing"])(
  "every vault command stops on a .env line `%s`",
  (line) => {
    appendFileSync(join(home, ".env"), `${line}\n`);

    for (const args of [
      ["run", "GitHub", "--", "env"],
      ["get", "GitHub", "password"],
    ]) {
      expect(vault(args)).toMatchObject({ code: 1, out: "" });
    }
  },
);

test("every vault command stops on settings it can't read", () => {
  writeFileSync(join(home, ".claude/settings.json"), "{");
  expect(vault(["save", "GitHub", "password"])).toMatchObject({ code: 1, out: "" });
});

test("vault fill still finds the computer in the settings", () => {
  expect(vault(["fill", "GitHub", "password"])).toEqual({
    code: 0,
    out: "typed GitHub's password on box\n",
    err: "export PRINTED=1\n",
  });
  expect(readFileSync(join(home, "typed"), "utf-8")).toBe("hunter2");
});
