import { command, ownThread, threadKey } from "../command.ts";
import { waiting } from "../tasks.ts";

export default command({
  usage: "hex questions [--thread <thread> | --all] [--json]",
  flags: {
    thread: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run(hex) {
    const thread = (await threadKey(hex, hex.flags.thread)) ?? ownThread(hex);

    const questions = await hex.store.questions.list({
      waiting: true,
      thread,
    });

    if (hex.flags.json === true) {
      console.log(
        JSON.stringify(
          questions.map((question) => ({
            ...question,
            threadId: `${question.app}:${question.thread}`,
          })),
          null,
          1,
        ),
      );
    } else {
      const names = await hex.store.threads.names();

      console.log(
        questions.map((question) => waiting(question, names)).join("\n") || "no questions waiting",
      );
    }
  },
});
