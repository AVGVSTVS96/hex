import { command, filled, named } from "../command.ts";

export default command({
  usage: "hex thread <thread> --project <the project it's part of, or '' for its own>",
  flags: {
    project: { type: "string" },
  },
  wordsBeforeFlags: () => 1,
  async run(hex) {
    const [given] = hex.args;
    const [thread, another] = filled(given) ? await named(hex, given) : [];

    if (another) {
      throw new Error(`more than one thread goes by ${given}: pass its id, from hex threads`);
    }

    if (!thread || hex.flags.project === undefined) {
      throw new Error(hex.usage);
    }

    await hex.store.threads.file(
      thread.thread,
      filled(hex.flags.project) ? hex.flags.project : undefined,
    );
  },
});
