import { command, filled, usage } from "../command.ts";

export default command({
  usage: "hex signal <name>[:<id>] <why…>",
  wordsBeforeFlags: () => Infinity,
  async run(hex) {
    const [given, ...words] = hex.args;
    const [name, ...id] = given?.split(":") ?? [];

    if (!filled(name) || words.length === 0) {
      usage(hex);
    }

    await hex.store.scheduler.signal(
      name,
      words.join(" "),
      id.length > 0 ? id.join(":") : undefined,
    );
  },
});
