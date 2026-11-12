import { join } from "node:path";

import { z } from "zod";

import { open } from "./store.ts";

const RESTART_SCHEDULED = "5eb03494b6584870a536b337290809b3";
const MINUTE = 60_000;

const Restart = z.object({
  USER_UNIT: z.string(),
  N_RESTARTS: z.coerce.number(),
  __CURSOR: z.string(),
});

const following = (storeDir: string) => [
  "journalctl",
  "--user",
  "--follow",
  "--output=json",
  "--lines=0",
  `--cursor-file=${join(storeDir, "restarts.cursor")}`,
  `MESSAGE_ID=${RESTART_SCHEDULED}`,
];

const systemdsBurst = () =>
  Number(
    Bun.spawnSync(["systemctl", "--user", "show", "--property=DefaultStartLimitBurst", "--value"])
      .stdout.toString()
      .trim(),
  );

export function restarts(
  storeDir: string,
  main: string,
  journal = following(storeDir),
  limit?: number,
): () => void {
  const store = open(storeDir);
  let burst = limit;
  let closed = false;
  let child: { kill: () => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const heard = (line: string) => {
    let restart: z.infer<typeof Restart>;

    try {
      restart = Restart.parse(JSON.parse(line));
    } catch {
      return;
    }

    if (restart.N_RESTARTS !== burst) {
      return;
    }

    const unit = restart.USER_UNIT;

    store.messages.deliver({
      key: `restarts:${unit}@${restart.__CURSOR}`,
      to: main,
      from: "restarts",
      author: "prompt",
      body: `[restarts] ${unit} keeps failing: systemd has restarted it ${burst} times in a row and goes on restarting it. \`journalctl --user -u ${unit}\` shows why.`,
      meta: { user: "restarts" },
    });
  };

  const follow = async () => {
    let journald: Bun.Subprocess<"ignore", "pipe", "inherit">;

    try {
      burst ??= systemdsBurst();
      journald = Bun.spawn(journal, { stdout: "pipe", stderr: "inherit" });
    } catch (error) {
      process.stderr.write(
        `hub: no systemd journal here, so units that keep failing go unheard: ${String(error)}\n`,
      );

      return;
    }

    child = journald;
    let rest = "";

    for await (const chunk of journald.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      lines.forEach(heard);
    }

    await journald.exited;

    if (!closed) {
      process.stderr.write(
        `hub: the journal stopped telling of units that keep failing; following it again in a minute\n`,
      );
      timer = setTimeout(() => void follow(), MINUTE);
    }
  };

  void follow();

  return () => {
    closed = true;
    clearTimeout(timer);
    child?.kill();
  };
}
