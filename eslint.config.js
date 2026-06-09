import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs}", "*.config.js"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
