import { definePlugin, defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { z } from "zod";

const Options = z
  .tuple([z.object({ allow: z.record(z.string(), z.int().min(1)) })])
  .or(z.tuple([]));

const isMock = (node: ESTree.CallExpression, names: Set<string>) => {
  const { callee } = node;

  if (callee.type === "Identifier") {
    return names.has(callee.name) && node.arguments.length > 0;
  }

  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    names.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    callee.property.name === "module"
  );
};

export default definePlugin({
  meta: { name: "no-bun-mocks" },
  rules: {
    "no-bun-mocks": defineRule({
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
      create: (context) => {
        const names = new Set<string>();
        const found: ESTree.Node[] = [];

        const [options] = Options.parse(context.options);

        const [path, allowed] = Object.entries(options?.allow ?? {}).find(([file]) =>
          context.physicalFilename.endsWith(`/${file}`),
        ) ?? ["", 0];

        return {
          ImportDeclaration: (node) => {
            if (node.source.value !== "bun:test") {
              return;
            }

            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                specifier.imported.name === "mock"
              ) {
                names.add(specifier.local.name);
              }
            }
          },
          CallExpression: (node) => {
            if (isMock(node, names)) {
              found.push(node);
            }
          },
          "Program:exit": (program) => {
            if (found.length < allowed) {
              context.report({
                message: `${path} now has ${found.length} mocks: lower its no-bun-mocks allowance in oxlint.config.ts to ${found.length}, or remove it at 0.`,
                node: program,
              });

              return;
            }

            if (found.length > allowed) {
              for (const node of found) {
                context.report({
                  message:
                    "A mock replaces what the test should prove. Run the real module; stand in only for what's outside hex, like a network service, with a real local server.",
                  node,
                });
              }
            }
          },
        };
      },
    }),
  },
});
