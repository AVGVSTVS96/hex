import { command, filled, show, threadKey, usage } from "../command.ts";

const wordsBeforeFlags = new Map([
  ["add", 3],
  ["quote", 3],
  ["new", 2],
  ["done", 2],
  ["drop", 2],
  ["open", 2],
  ["edit", 2],
  ["agent", Infinity],
]);

export default command({
  usage: `hex task new <message key> --title '<what the owner wants, in a few plain words>' [--quote <part of it>] [--owner <thread>] [--project <name>] [--done-when <outcome>] [--idea]
hex task add <task> <message key> [--quote <part of it>]
hex task quote <task> <message key> --quote <part of it>
hex task done <task> --proof <link or fact>
hex task drop <task> [--into <task it repeats>]
hex task open <task>
hex task edit <task> [--title '<title>'] [--owner <thread>] [--project <name>] [--done-when <outcome>]
hex task agent <task> <agent or session id…>
hex task <task> [--json]`,
  flags: {
    title: { type: "string" },
    quote: { type: "string" },
    owner: { type: "string" },
    project: { type: "string" },
    "done-when": { type: "string" },
    idea: { type: "boolean" },
    proof: { type: "string" },
    into: { type: "string" },
    json: { type: "boolean" },
  },
  wordsBeforeFlags: ([verb = ""]) => wordsBeforeFlags.get(verb) ?? 1,
  async run(hex) {
    const { flags, store } = hex;
    const [verb = "", id, key] = hex.args;
    const more = hex.args.slice(2);
    const thread = process.env.HEX_THREAD;
    const owner = await threadKey(hex, flags.owner);

    switch (verb) {
      case "new": {
        const said = filled(id) ? await store.messages.get(id) : null;

        if (!filled(id) || !said) {
          throw new Error(
            filled(id) ? `no message ${id}` : "name the message the task comes from by its key",
          );
        }

        await show(hex, [
          await store.tasks.create({
            title: flags.title ?? "",
            message: id,
            owner: owner ?? thread ?? said.to,
            status: flags.idea === true ? "idea" : "open",
            quote: flags.quote,
            project: flags.project,
            doneWhen: flags["done-when"],
          }),
        ]);

        return;
      }

      case "add": {
        if (!filled(id) || !filled(key)) {
          usage(hex);
        }

        await show(hex, [await store.tasks.addWords(id, key, flags.quote)]);

        return;
      }

      case "quote": {
        if (!filled(id) || !filled(key) || !filled(flags.quote)) {
          usage(hex);
        }

        await show(hex, [await store.tasks.requote(id, key, flags.quote)]);

        return;
      }

      case "done": {
        if (!filled(id) || !filled(flags.proof)) {
          throw new Error("a task is done with --proof: a link or a fact that shows it");
        }

        await show(hex, [
          await store.tasks.edit(id, {
            status: "done",
            proof: flags.proof,
            doneIn: thread,
          }),
        ]);

        return;
      }

      case "drop": {
        if (!filled(id)) {
          usage(hex);
        }

        await show(hex, [
          await (filled(flags.into)
            ? store.tasks.merge(flags.into, id)
            : store.tasks.edit(id, { status: "dropped" })),
        ]);

        return;
      }

      case "open": {
        if (!filled(id)) {
          usage(hex);
        }

        await show(hex, [await store.tasks.edit(id, { status: "open" })]);

        return;
      }

      case "edit": {
        if (!filled(id)) {
          usage(hex);
        }

        await show(hex, [
          await store.tasks.edit(id, {
            title: flags.title,
            owner,
            project: flags.project,
            doneWhen: flags["done-when"],
          }),
        ]);

        return;
      }

      case "agent": {
        if (!filled(id) || more.length === 0) {
          usage(hex);
        }

        await show(hex, [await store.tasks.addAgents(id, more, thread)]);

        return;
      }

      default: {
        const found = filled(verb) ? await store.tasks.get(verb) : null;

        if (!found) {
          throw new Error(filled(verb) ? `no task ${verb}` : hex.usage);
        }

        await show(hex, [found]);
      }
    }
  },
});
