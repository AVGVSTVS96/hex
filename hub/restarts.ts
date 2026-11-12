import { z } from "zod";

import { open } from "./store.ts";

const RESTART_SCHEDULED = "5eb03494b6584870a536b337290809b3";
const MINUTE = 60_000;

const Restart = z.object({
  USER_UNIT: z.string(),
  __REALTIME_TIMESTAMP: z.coerce.number(),
});

const dayOf = (microseconds: number) => new Date(microseconds / 1000).toISOString().slice(0, 10);

const sinceToday = () => [
  "journalctl",
  "--user",
  "--follow",
  "--output=json",
  `--since=@${Math.floor(Date.parse(dayOf(Date.now() * 1000)) / 1000)}`,
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
  journal = sinceToday,
  limit?: number,
): () => void {
  const store = open(storeDir);
  const counted = new Map<string, number>();
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

    const unit = restart.USER_UNIT;
    const day = `${unit}@${dayOf(restart.__REALTIME_TIMESTAMP)}`;
    const count = (counted.get(day) ?? 0) + 1;
    counted.set(day, count);

    if (count !== burst) {
      return;
    }

    store.messages.deliver({
      key: `restarts:${day}`,
      to: main,
      from: "restarts",
      author: "prompt",
      body: `[restarts] ${unit} keeps failing: systemd has restarted it ${burst} times today. \`journalctl --user -u ${unit}\` shows why.`,
      meta: { user: "restarts" },
    });
  };

  const follow = async () => {
    let journald: Bun.Subprocess<"ignore", "pipe", "inherit">;

    try {
      burst ??= systemdsBurst();
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
