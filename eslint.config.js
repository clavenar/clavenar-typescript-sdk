// Flat-config ESLint setup for clavenar-typescript-sdk.
//
// Composes the standard JS + typescript-eslint recommended rule sets and
// disables stylistic rules that conflict with Prettier (eslint-config-prettier
// must come last to override any prior style rules).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "examples/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // The SDK intentionally accepts `unknown` from upstream provider
      // SDKs (Anthropic / OpenAI) and narrows at boundaries; blanket
      // banning `any` would be noise. Keep `no-explicit-any` as a warn
      // so new uses surface in review without breaking CI.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
