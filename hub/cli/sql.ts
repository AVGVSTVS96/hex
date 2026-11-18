import { command, filled, usage } from "../command.ts";

export default command({
  usage: "hex sql '<a query, which can change nothing>'",
  wordsBeforeFlags: () => 1,
  async run(hex) {
    const [query] = hex.args;

    if (!filled(query)) {
      usage(hex);
    }

    for (const row of await hex.store.read(query)) {
      console.log(JSON.stringify(row));
    }
  },
});
