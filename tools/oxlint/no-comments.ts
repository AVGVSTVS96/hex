import { definePlugin, defineRule } from "@oxlint/plugins";
import { z } from "zod";

const kept = /^\s*(?:(?:SAFETY|WARNING): [^\n]+$|oxlint-(?:disable|enable)\S* .+ -- \S)|https:\/\//u;
const directive = /^\s*oxlint-(?:disable|enable)/u;

const Options = z
  .tuple([z.object({ allow: z.record(z.string(), z.int().min(1)) })])
  .or(z.tuple([]));

export default definePlugin({
  meta: { name: "no-comments" },
  rules: {
    "no-comments": defineRule({
      create: (context) => ({
        Program: () => {
          for (const comment of context.sourceCode.getAllComments()) {
            if (comment.type !== "Shebang" && !kept.test(comment.value)) {
              context.report({
                message:
                  "Comments are banned: say it in a name, a type, a test or the commit. Kept: a link to an outside fact (https://…), a one-line SAFETY: for a type assertion, a one-line WARNING: for a footgun from outside hex, a lint directive with its reason after --.",
                node: comment,
              });
            }
          }
        },
      }),
    }),
    most: defineRule({
      meta: {
        schema: [
          {
            additionalProperties: false,
            properties: {
              allow: { additionalProperties: { minimum: 1, type: "integer" }, type: "object" },
            },
            type: "object",
          },
        ],
      },
      create: (context) => ({
        Program: (program) => {
          const [options] = Options.parse(context.options);

          const [path, allowed] = Object.entries(options?.allow ?? {}).find(([file]) =>
            context.physicalFilename.endsWith(`/${file}`),
          ) ?? [context.filename, 0];

          const count = context.sourceCode
            .getAllComments()
            .filter(
              (comment) => comment.type !== "Shebang" && !directive.test(comment.value),
            ).length;

          if (count > allowed) {
            context.report({
              message: `${path} has ${count} comments and may have at most ${allowed}: the list in tools/oxlint/allowances.json only shrinks. Say it in a name, a type, a test or the commit instead.`,
              node: program,
            });
          } else if (count < allowed) {
            context.report({
              message: `${path} now has ${count} comments: lower its comments entry in tools/oxlint/allowances.json to ${count}, or remove it at 0.`,
              node: program,
            });
          }
        },
      }),
    }),
  },
});
