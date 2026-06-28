import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "build/**",
      "data/**",
      "dist/**",
      "node_modules/**"
    ]
  },
  {
    files: ["*.js", "*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  }
];
