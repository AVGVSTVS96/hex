import { command, ownThread, threadKey } from "../command.ts";

export default command({
  usage: "hex pins [--thread <thread> | --all] [--json]",
  flags: {
    thread: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run(hex) {
    const thread = (await threadKey(hex, hex.flags.thread)) ?? ownThread(hex);
    const pins = await hex.store.pins.list({ thread });
    const names = await hex.store.threads.names();

    if (hex.flags.json === true) {
      console.log(
        JSON.stringify(
          pins.map((pin) => ({ ...pin, threadId: `${pin.app}:${pin.thread}` })),
          null,
          1,
        ),
      );
    } else {
      console.log(
        pins
          .map(
            (pin) =>
              `${pin.app} · ${names[pin.thread] ?? pin.thread} · message ${pin.message} · ${(pin.note === "" ? pin.text : pin.note).trim().split("\n")[0]}`,
          )
          .join("\n") || "no pins",
      );
    }
  },
});
