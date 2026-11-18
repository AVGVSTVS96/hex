import { command, ownThread, show, threadKey } from "../command.ts";
import type { Status } from "../store.ts";

const STATUSES: Record<Status, true> = { idea: true, open: true, done: true, dropped: true };

function isStatus(word: string): word is Status {
  return Object.hasOwn(STATUSES, word);
}

export default command({
  usage: "hex tasks [--owner <thread> | --all] [--status open,idea,done,dropped] [--json]",
  flags: {
    owner: { type: "string" },
    all: { type: "boolean" },
    status: { type: "string" },
    json: { type: "boolean" },
  },
  async run(hex) {
    const owner = (await threadKey(hex, hex.flags.owner)) ?? ownThread(hex);

    await show(
      hex,
      await hex.store.tasks.list({
        status: hex.flags.status?.split(",").filter(isStatus) ?? ["open"],
        owner,
      }),
      false,
    );
  },
});
