import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".data/**", "public/**", "scripts/legacy/**", "**/*.cjs", "**/*.mjs", "**/*.mts", "*.js", "src/server/data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "unused-imports": unusedImports },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // real-bug rules stay on
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // pragmatic for an existing codebase
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // `{false && (...)}` is used on purpose to keep retired UI sections parked.
      "no-constant-binary-expression": "off",
      "no-useless-escape": "warn",
      "no-control-regex": "off",
      "prefer-const": "warn",
    },
  },
);
