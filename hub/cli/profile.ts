import { command } from "../command.ts";

export default command({
  usage: "hex profile [--all] [--json]",
  flags: {
    all: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run({ flags, store }) {
    const everyVersion = flags.all === true;
    const every = await store.profiles.list();
    const versions = everyVersion ? every : every.slice(0, 1);

    if (flags.json === true) {
      console.log(JSON.stringify(everyVersion ? versions : (versions[0] ?? null), null, 1));
    } else {
      console.log(
        versions.map(({ at, body }) => (everyVersion ? `--- ${at}\n${body}\n` : body)).join("\n") ||
          "no profile yet",
      );
    }
  },
});
