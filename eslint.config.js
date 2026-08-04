import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "build/**",
      "data/**",
      "dist/**",
      "dist.nosync/**",
      "node_modules/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["app/**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    files: [
      "ios/VigilBrowser/VigilSafariExtension/Resources/*.js",
      "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/*.js"
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions }
    }
  }
];
