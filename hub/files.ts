import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type * as claude from "./claude.ts";
import { present } from "./present.ts";

function tokenOf(stateDir: string) {
  const file = join(stateDir, "token");

  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  return readFileSync(file, "utf-8").trim();
}

export type SessionFiles = ReturnType<typeof sessionFiles>;

export function sessionFiles({
  stateDir,
  channel,
  plugin,
  socketPath,
  port,
  storeDir,
  connect,
  generalThread,
  fresh,
}: {
  stateDir: string;
  channel: string;
  plugin: string;
  socketPath: string;
  port: number;
  storeDir: string;
  connect: number;
  generalThread: string | undefined;
  fresh: (thread: string) => boolean;
}) {
  const dir = join(stateDir, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = tokenOf(stateDir);

  function envOf(thread: string) {
    return {
      HEX_CHANNEL: channel,
      HEX_THREAD: thread,
      HEX_PORT: String(port),
      HEX_TOKEN: token,
      HEX_STORE: storeDir,
      ...(thread === generalThread && { HEX_MAIN: "1" }),
    };
  }

  function settingsOf(thread: string) {
    return join(dir, `${encodeURIComponent(thread)}.json`);
  }

  function besideSettingsOf(thread: string) {
    return join(dir, `beside-${encodeURIComponent(thread)}.json`);
  }

  function besideLog(session: string) {
    return join(dir, `beside-${session}.log`);
  }

  function write(
    thread: string,
    launched: ReturnType<typeof claude.settingsOf> = {},
    takesOverFrom?: string,
  ) {
    const env = {
      ...envOf(thread),
      HEX_HUB: socketPath,
      ...(connect && { MCP_TIMEOUT: String(connect) }),
      ...(fresh(thread) && { HEX_FRESH: "1" }),
      ...(present(takesOverFrom) && { HEX_HANDOFF: takesOverFrom }),
    };

    writeFileSync(
      settingsOf(thread),
      JSON.stringify({
        ...launched,
        enabledPlugins: { ...launched?.enabledPlugins, [plugin]: true },
        env: { ...launched?.env, ...env },
      }),
      { mode: 0o600 },
    );
  }

  function writeBeside(thread: string) {
    writeFileSync(
      besideSettingsOf(thread),
      JSON.stringify({ enabledPlugins: { [plugin]: true }, env: envOf(thread) }),
      { mode: 0o600 },
    );
  }

  function forget(thread: string) {
    rmSync(settingsOf(thread), { force: true });
    rmSync(besideSettingsOf(thread), { force: true });
  }

  function sweepBesideLogs(running: (session: string) => boolean) {
    for (const file of readdirSync(dir)) {
      const session = /^beside-(.+)\.log$/u.exec(file)?.[1];

      if (session !== undefined && !running(session)) {
        rmSync(join(dir, file), { force: true });
      }
    }
  }

  return {
    token,
    settingsOf,
    besideSettingsOf,
    besideLog,
    write,
    writeBeside,
    forget,
    sweepBesideLogs,
  };
}
