import { payOwedFacts } from "./kept.ts";
import { tellOwner } from "./notice.ts";

const state = process.argv[2] ?? "";

const paid = await payOwedFacts(state, (why) => void tellOwner(why));

process.stderr.write(
  paid
    ? "hex: what this machine's hubs owed is in hex's store\n"
    : "hex: hex's store didn't take all this machine's hubs owed, so it stays in state/owed.*.json\n",
);

process.exit(paid ? 0 : 1);
