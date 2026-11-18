import { command, filled } from "../command.ts";

export default command({
  usage: "hex threads [--json]",
  flags: {
    json: { type: "boolean" },
  },
  async run({ flags, store }) {
    const threads = await store.threads.list();

    if (flags.json === true) {
      console.log(
        JSON.stringify(
          threads.map((thread) => ({ id: `${thread.app}:${thread.thread}`, ...thread })),
          null,
          1,
        ),
      );
    } else {
      console.log(
        threads
          .map(
            ({ app, thread, name, open, project }) =>
              `${app} ${thread} ${name}${filled(project) ? ` (project ${project})` : ""}${open ? "" : " (closed)"}`,
          )
          .join("\n"),
      );
    }
  },
});
