import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const rules = {
  ...js.configs.recommended.rules,
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-redeclare": "off",
  "no-undef": "off",
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-array-delete": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
  "@typescript-eslint/no-for-in-array": "error",
  "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-enum-comparison": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-unary-minus": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/restrict-plus-operands": "error"
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
    files: ["app/**/*.ts", "scripts/**/*.mts", "src/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: nodeGlobals
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    rules
  },
  {
    files: ["public/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser
      }
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    rules
  },
  {
    files: ["extension/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        browser: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    rules
  }
];
