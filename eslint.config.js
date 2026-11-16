import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  {
    // The library: checked with types, since most of what goes wrong in
    // geometry code is a number that turned out to be undefined
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The tests and this file are plain JS run by Node
    files: ["test/**/*.js", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
);
