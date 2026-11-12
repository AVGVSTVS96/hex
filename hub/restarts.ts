import { z } from "zod";

import { open } from "./store.ts";

const RESTART_SCHEDULED = "5eb03494b6584870a536b337290809b3";
const MINUTE = 60_000;

const Restart = z.object({
  USER_UNIT: z.string(),
  N_RESTARTS: z.coerce.number(),
  __REALTIME_TIMESTAMP: z.coerce.number(),
});

const dayOf = (milliseconds: number) => new Date(milliseconds).toLocaleDateString("sv");

export const sinceToday = () => [
  "journalctl",
  "--user",
  "--follow",
  "--output=json",
  `--since=@${Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)}`,
  `MESSAGE_ID=${RESTART_SCHEDULED}`,
];

const systemdsBurst = () => {
  const systemctl = Bun.which("systemctl");

  const burst =
    systemctl === null
      ? Number.NaN
      : Number(
          Bun.spawnSync([
            systemctl,
            "--user",
            "show",
            "--property=DefaultStartLimitBurst",
            "--value",
          ])
            .stdout.toString()
            .trim(),
        );

  return Number.isInteger(burst) && burst > 0 ? burst : 5;
};

export function restarts(
  storeDir: string,
  main: string,
  journal: () => string[],
  limit?: number,
): () => void {
  const store = open(storeDir);
  const counted = new Map<string, number>();
  const burst = limit ?? systemdsBurst();
  let closed = false;
  let child: { kill: () => void } | undefined;
  let followed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const heard = (line: string) => {
    let restart: z.infer<typeof Restart>;

    try {
      restart = Restart.parse(JSON.parse(line));
    } catch {
      return;
    }

    const unit = restart.USER_UNIT;
    const at = restart.__REALTIME_TIMESTAMP / 1000;
    const day = `${unit}@${dayOf(at)}`;
    const count = (counted.get(day) ?? 0) + 1;
    counted.set(day, count);

    if (at < followed || count < burst || restart.N_RESTARTS < burst) {
      return;
    }

    store.messages.deliver({
      key: `restarts:${day}`,
      to: main,
      from: "restarts",
      author: "prompt",
      body: `[restarts] ${unit} keeps failing: systemd has restarted it ${count} times today. \`journalctl --user -u ${unit}\` shows why.`,
      meta: { user: "restarts" },
    });
  };

  const follow = async () => {
    let journald: Bun.Subprocess<"ignore", "pipe", "inherit">;

    try {
      followed = Date.now();
      journald = Bun.spawn(journal(), { stdout: "pipe", stderr: "inherit" });
    } catch (error) {
      process.stderr.write(
        `hub: no systemd journal here, so units that keep failing go unheard: ${String(error)}\n`,
      );

      return;
    }

    child = journald;
    counted.clear();
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
