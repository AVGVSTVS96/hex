import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const HEX = join(import.meta.dir, "../..");

let root: string;
let home: string;
let hex: string;
let bin: string;

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "restore-"));
  home = join(root, "hex");
  hex = join(home, ".hex");
  bin = join(root, "stubs");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(hex, "vendor"));
  mkdirSync(bin);

  for (const path of [
    "defaults",
    "systemd",
    "services.json",
    "bin/hex",
    "bin/settings",
    "bin/trust",
  ]) {
    cpSync(join(HEX, path), join(hex, path), { recursive: true });
  }

  for (const stub of ["bin/optmem", "bin/wake", "vendor/memo"]) {
    script(join(hex, stub), "");
  }

  for (const channel of ["telegram", "voice"]) {
    mkdirSync(join(hex, "channels", channel), { recursive: true });
    writeFileSync(join(hex, "channels", channel, ".mcp.json"), "{}");
  }

  mkdirSync(join(hex, "channels/iikb"));
  const log = `echo "$(basename "$0") $*" >> ${root}/calls`;
  script(
    join(bin, "systemctl"),
    `${log}\ncase "$*" in *show-environment*) ;; *"-q is-active"*) exit 3 ;; *is-active*) echo inactive; exit 3 ;; *is-failed*) exit 1 ;; esac`,
  );
  script(join(bin, "loginctl"), `${log}\ncase "$*" in show-user*) echo no ;; esac`);
  script(
    join(bin, "claude"),
    `${log}\ncase "$*" in *--json*) echo '[]' ;; auth*) echo '{}' ;; esac`,
  );
  script(join(bin, "sudo"), `${log}\ncat > ${root}/managed.json`);
  script(join(bin, "bun"), log);
  const claudeWroteItsConfigAsItFirstRan = join(root, "claude/.claude.json");
  mkdirSync(join(root, "claude"));
  writeFileSync(claudeWroteItsConfigAsItFirstRan, "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function restore() {
  const run = Bun.spawnSync([join(hex, "bin/hex"), "restore"], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      PATH: `${bin}:${process.env.PATH}`,
      SHELL: "/bin/sh",
      HEX_MANAGED_SETTINGS: join(root, "managed.json"),
    },
  });

  return { out: run.stdout.toString(), err: run.stderr.toString(), code: run.exitCode };
}

const calls = () => readFileSync(join(root, "calls"), "utf-8");

type List = {
  install?: Record<string, string>;
  units?: string[];
  managed?: { cleanupPeriodDays: number };
};

const Managed = z.object({
  channelsEnabled: z.boolean(),
  cleanupPeriodDays: z.number(),
  allowedChannelPlugins: z.array(z.object({ plugin: z.string(), marketplace: z.string() })),
});

const Config = z.object({
  projects: z.record(z.string(), z.object({ hasTrustDialogAccepted: z.boolean() })),
});

const read = <T>(schema: z.ZodType<T>, path: string): T =>
  schema.parse(JSON.parse(readFileSync(join(root, path), "utf-8")));

function owner(list: List) {
  writeFileSync(join(home, "services.json"), JSON.stringify(list));
}

test("restore installs what's missing once, links the units of both lists, and enables those with an [Install] section", () => {
  mkdirSync(join(home, "services/hex.service.d"), { recursive: true });
  writeFileSync(
    join(home, "services/mail.service"),
    "[Service]\n\n[Install]\nWantedBy=default.target\n",
  );
  writeFileSync(join(home, "services/mail.path"), "[Path]\n");
  writeFileSync(join(home, "services/hex.service.d/vault.conf"), "[Service]\n");
  owner({
    install: { "~/tools/made": "mkdir -p ~/tools && echo once >> ~/tools/made", sh: "exit 1" },
    units: ["services/mail.service", "services/mail.path", "services/hex.service.d/vault.conf"],
  });

  expect(restore().out).toContain("installing ~/tools/made");
  restore();
  expect(readFileSync(join(root, "tools/made"), "utf-8")).toBe("once\n");

  const units = join(root, "config/systemd/user");
  expect(readlinkSync(join(units, "hex.service"))).toBe(join(hex, "systemd/hex.service"));
  expect(readlinkSync(join(units, "mail.service"))).toBe(join(home, "services/mail.service"));
  expect(lstatSync(join(units, "hex.service.d")).isDirectory()).toBe(true);
  expect(readlinkSync(join(units, "hex.service.d/vault.conf"))).toBe(
    join(home, "services/hex.service.d/vault.conf"),
  );
  expect(calls()).toContain("systemctl --user enable --now hex.service mail.service\n");
  expect(calls()).toContain(`bun install --no-summary --cwd ${hex}\n`);
  expect(calls()).toContain("loginctl enable-linger");
});

test("restore installs each channel that has a server, turned off, allows it, and trusts the folder", () => {
  owner({ managed: { cleanupPeriodDays: 30 } });
  restore();

  for (const channel of ["telegram", "voice"]) {
    expect(calls()).toContain(
      `claude plugin install ${channel}@hex\nclaude plugin disable ${channel}@hex\n`,
    );
  }

  expect(calls()).not.toContain("iikb");

  const managed = read(Managed, "managed.json");
  expect(managed.channelsEnabled).toBe(true);
  expect(managed.cleanupPeriodDays).toBe(30);
  expect(managed.allowedChannelPlugins).toContainEqual({ plugin: "voice", marketplace: "hex" });
  expect(read(Config, "claude/.claude.json").projects[home]?.hasTrustDialogAccepted).toBe(true);
});

test("a hub that hex.service's ExecCondition keeps off this machine waits, and doctor says so", () => {
  script(
    join(bin, "systemctl"),
    `case "$*" in *show-environment*) ;; *"-p Result"*) echo exec-condition ;; *"-q is-active"*) exit 3 ;; *is-active*) echo inactive; exit 3 ;; *is-failed*) exit 1 ;; esac`,
  );
  const run = restore();
  expect(run.out).toContain(
    "ok   hub waits: hex.service's ExecCondition keeps it off this machine",
  );
  expect(run.out).not.toContain("the hub isn't running");
});

test("a folder other than ~/hex gets a drop-in that has hex.service run it, gone once it moves to ~/hex", () => {
  renameSync(home, join(root, "assistant"));
  home = join(root, "assistant");
  hex = join(home, ".hex");
  restore();
  expect(readFileSync(join(root, "config/systemd/user/hex.service.d/folder.conf"), "utf-8")).toBe(
    `[Service]\nExecStart=\nExecStart="${hex}/bin/hex" run\n`,
  );

  renameSync(home, join(root, "hex"));
  home = join(root, "hex");
  hex = join(home, ".hex");
  restore();
  expect(existsSync(join(root, "config/systemd/user/hex.service.d/folder.conf"))).toBe(false);
});

test("a unit file of the machine's own gives way only when it says the same", () => {
  const units = join(root, "config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "hex.service"), readFileSync(join(hex, "systemd/hex.service")));
  writeFileSync(join(units, "hex-sessions.slice"), "[Slice]\nMemoryMax=1G\n");
  const run = restore();
  expect(run.err).toContain(`${units}/hex-sessions.slice is a file of this machine's own`);
  expect(readlinkSync(join(units, "hex.service"))).toBe(join(hex, "systemd/hex.service"));
  expect(readFileSync(join(units, "hex-sessions.slice"), "utf-8")).toBe("[Slice]\nMemoryMax=1G\n");
});

test("a drop-in folder that's a link to another repo, which systemd skips, becomes a real one, and that repo stays as it was", () => {
  mkdirSync(join(home, "services/mail.service.d"), { recursive: true });
  writeFileSync(join(home, "services/mail.service.d/holder.conf"), "[Service]\n");
  owner({ units: ["services/mail.service.d/holder.conf"] });
  const dotfiles = join(root, "dotfiles/mail.service.d");
  mkdirSync(dotfiles, { recursive: true });
  writeFileSync(join(dotfiles, "holder.conf"), "[Service]\n");
  const units = join(root, "config/systemd/user");
  mkdirSync(units, { recursive: true });
  symlinkSync(dotfiles, join(units, "mail.service.d"));

  restore();
  expect(lstatSync(join(units, "mail.service.d")).isDirectory()).toBe(true);
  expect(readlinkSync(join(units, "mail.service.d/holder.conf"))).toBe(
    join(home, "services/mail.service.d/holder.conf"),
  );
  expect(lstatSync(join(dotfiles, "holder.conf")).isFile()).toBe(true);
});

test("a channel that doesn't install stops restore, and a marketplace of another hex's is replaced", () => {
  script(
    join(bin, "claude"),
    `echo "claude $*" >> ${root}/calls\ncase "$*" in "plugin marketplace list --json") echo '[{"name":"hex","path":"/elsewhere/.hex/channels"}]' ;; *--json*) echo '[]' ;; "plugin install telegram@hex") exit 1 ;; esac`,
  );
  const run = restore();
  expect(calls()).toContain(
    `claude plugin marketplace remove hex\nclaude plugin marketplace add ${hex}/channels\n`,
  );
  expect(run.err).toContain("restore: the telegram channel didn't install");
  expect(run.code).toBe(1);
});

test("restore stops at a line that doesn't make what it names", () => {
  owner({ install: { "~/never": "true" }, units: ["services/gone.service"] });
  const run = restore();
  expect(run.err).toContain("restore: `true` didn't make ~/never");
  expect(existsSync(join(root, "calls"))).toBe(false);
});
