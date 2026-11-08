import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "site/**", "media/**"],
  jsPlugins: [{ name: "no-comments", specifier: "./tools/oxlint/no-comments.ts" }],
  options: { reportUnusedDisableDirectives: "error", typeAware: true },
  rules: {
    "eslint/complexity": "off",
    "eslint/default-case": "off",
    "eslint/func-style": "off",
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
