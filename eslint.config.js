import js from "@eslint/js";
import globals from "globals";

const rules = {
  ...js.configs.recommended.rules,
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
};

const nodeGlobals = {
  ...globals.node,
  AbortController: "readonly",
  fetch: "readonly",
  Response: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly"
};

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
    files: ["app/**/*.js", "scripts/**/*.mjs", "src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    rules
  },
  {
    files: ["extension/**/*.js", "public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        browser: "readonly"
      }
    },
    rules
  }
];
