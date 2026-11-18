import { command, filled } from "../command.ts";
import { sent } from "../store.ts";

export default command({
  usage: "hex message <key>",
  flags: {
    json: { type: "boolean" },
  },
  wordsBeforeFlags: () => 1,
  async run({ args, flags, store }) {
    const [key] = args;
    const said = filled(key) ? await store.messages.latest(key) : null;

    if (!said) {
      throw new Error(`no message ${key ?? ""}`);
    }

    console.log(
      flags.json === true
        ? JSON.stringify(said, null, 1)
        : said.from === "t3" && said.author === "owner"
          ? sent(said.body).join("\n\n")
          : said.body,
    );
    const under = said.meta?.edit ?? (said.key === key ? undefined : said.key);

    if (filled(under) && flags.json !== true) {
      console.error(`(edited: these are the words of ${under}, the key to quote them under)`);
    }
  },
});
