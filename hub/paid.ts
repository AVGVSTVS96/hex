import { payOwedFacts } from "./kept.ts";
import { queue } from "./observe.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Lands what a folder's hubs owed as fact, with no hub and no claim, for a machine that won't run a hub (bin/hex on state/lost): exits 0 once nothing is owed.
const state = process.argv[2] ?? "";

const paid = await payOwedFacts(state, async (turn, store) => {
  await queue(state, turn, store);
});

process.stderr.write(
  paid
    ? "hex: what this machine's hubs owed is in hex's store\n"
    : "hex: hex's store didn't take all this machine's hubs owed, so it stays in state/owed.*.json\n",
);

process.exit(paid ? 0 : 1);
