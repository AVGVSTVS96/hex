import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

const functionLines = (
  max: number,
): ["error", { max: number; skipBlankLines: boolean; skipComments: boolean }] => [
  "error",
  { max, skipBlankLines: true, skipComments: true },
];

const longestFunctionIn = {
  "channels/buzz/activity.ts": 416,
  "channels/buzz/bot.ts": 1105,
  "channels/buzz/memory.ts": 337,
  "channels/buzz/relay.ts": 256,
  "channels/discord/bot.ts": 1231,
  "channels/voice/phone.test.ts": 219,
  "channels/voice/reconnect.test.ts": 304,
  "hub/hub.ts": 1108,
  "hub/mcp.ts": 302,
  "hub/sessions.ts": 375,
};

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "site/**", "media/**", "watch/**"],
  jsPlugins: [{ name: "no-comments", specifier: "./tools/oxlint/no-comments.ts" }],
  overrides: Object.entries(longestFunctionIn).map(([file, lines]) => ({
    files: [file],
    rules: { "eslint/max-lines-per-function": functionLines(lines) },
  })),
  options: { reportUnusedDisableDirectives: "error", typeAware: true },
  rules: {
    "eslint/complexity": "off",
    "eslint/default-case": "off",
    "eslint/func-style": "off",
    "eslint/max-lines-per-function": functionLines(200),
    "eslint/no-await-in-loop": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/no-plusplus": "off",
    "eslint/no-use-before-define": "off",
    "eslint/no-void": "off",
    "eslint/prefer-destructuring": "off",
    "eslint/prefer-named-capture-group": "off",
    "eslint/sort-keys": "off",
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "typescript/consistent-return": "off",
    "typescript/consistent-type-definitions": "off",
    "typescript/promise-function-async": "off",
    "unicorn/import-style": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/no-await-expression-member": "off",
    "import/no-cycle": "error",
    "no-comments/no-comments": "error",
    "oxc/no-accumulating-spread": "error",
  },
});
