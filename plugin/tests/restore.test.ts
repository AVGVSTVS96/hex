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
  rmSync,
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

  for (const path of ["defaults", "systemd", "services.json", "bin/hex", "bin/settings"]) {
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
    },
  });

  return { out: run.stdout.toString(), err: run.stderr.toString() };
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

test("restore stops at a line that doesn't make what it names", () => {
  owner({ install: { "~/never": "true" }, units: ["services/gone.service"] });
  const run = restore();
  expect(run.err).toContain("restore: `true` didn't make ~/never");
  expect(existsSync(join(root, "calls"))).toBe(false);
});
