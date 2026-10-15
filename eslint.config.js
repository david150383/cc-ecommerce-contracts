import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    // `const { $id, ...rest } = x` drops fields on purpose.
    rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true }] },
  },
];
