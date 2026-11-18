import { existsSync } from "node:fs";

import { command, filled, usage } from "../command.ts";
import { awayFile, unlease } from "../store.ts";

export default command({
  usage: `hex store copy <file>
hex store lease clear
hex store move <the address of the Worker that takes hex's records> <the name of its object>, with its key in HEX_STORE_KEY`,
  wordsBeforeFlags: () => 2,
  async run(hex) {
    const [what, to] = hex.args;

    if (what === "lease" && to === "clear") {
      if (!existsSync(awayFile(hex.state))) {
        console.error("hex store lease: this hex's records are in hex.db, which has no lease");
        process.exit(1);
      }

      await unlease(hex.state);
      console.log("hex's lease is cleared: a hub with no HEX_STORE_LEASE can take hex now");

      return;
    }

    if (what !== "copy" || !filled(to)) {
      usage(hex);
    }

    await hex.store.copy(to);
  },
});
