import landmines from "@interfere/landmines/configs/recommended.json" with { type: "json" };
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

import allowances from "./tools/oxlint/allowances.json" with { type: "json" };

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
  "hub/hub.ts": 430,
  "hub/inbox.ts": 267,
  "hub/mcp.ts": 302,
  "hub/sessions.ts": 375,
};

const bunMocksIn = {
  "channels/discord/bot.test.ts": 1,
  "channels/discord/voice.test.ts": 1,
  "channels/telegram/bot.test.ts": 2,
  "hub/hub.testing.ts": 3,
  "hub/late.testing.ts": 1,
  "hub/store/object.testing.ts": 1,
};

const doublesIn = [
  "channels/discord/bot.test.ts",
  "channels/telegram/bot.test.ts",
  "hub/failing.hub.test.ts",
  "hub/sessions.hub.test.ts",
];

export default defineConfig({
  extends: [core, antiSlop, landmines],
  ignorePatterns: [...(core.ignorePatterns ?? []), "site/**", "media/**", "watch/**"],
  jsPlugins: [
    { name: "no-comments", specifier: "./tools/oxlint/no-comments.ts" },
    { name: "no-bun-mocks", specifier: "./tools/oxlint/no-bun-mocks.ts" },
  ],
  overrides: [
    ...Object.entries(longestFunctionIn).map(([file, lines]) => ({
      files: [file],
      rules: { "eslint/max-lines-per-function": functionLines(lines) },
    })),
    {
      files: doublesIn,
      rules: { "landmines-testing/no-test-doubles": "off" },
    },
  ],
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
    "no-bun-mocks/no-bun-mocks": ["error", { allow: bunMocksIn }],
    "landmines-style/no-comments": "off",
    "landmines-testing/no-fixed-sleep": ["error", { allow: allowances.sleeps }],
    "landmines-testing/no-flake-masking": ["error", { allow: allowances.flakes }],
    "landmines-types/no-explicit-return-types": "off",
    "no-comments/most": ["error", { allow: allowances.comments }],
    "no-comments/no-comments": "error",
    "oxc/no-accumulating-spread": "error",
  },
});
