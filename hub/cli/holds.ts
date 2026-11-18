import { dirname } from "node:path";

import { command } from "../command.ts";
import { line } from "../holds.ts";
import { zoneOf } from "../zone.ts";

export default command({
  usage: "hex holds [--all] [--json]",
  flags: {
    all: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run({ flags, state, store }) {
    const listed = await store.holds.list({ all: flags.all === true });

    if (flags.json === true) {
      console.log(JSON.stringify(listed, null, 1));
    } else {
      console.log(
        (await Promise.all(listed.map((each) => line(each, store, zoneOf(dirname(state)))))).join(
          "\n",
        ) || "nothing on hold",
      );
    }
  },
});
