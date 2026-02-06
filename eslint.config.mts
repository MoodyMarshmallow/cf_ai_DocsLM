import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import json from "@eslint/json";
import { defineConfig } from "eslint/config";

const jsonPlugin = json as unknown as Record<string, unknown>;

export default defineConfig([
  {
    ignores: [
      "package-lock.json",
      "apps/web/package-lock.json",
      "apps/web/tsconfig*.json",
      "worker-configuration.d.ts",
      ".wrangler/**",
      "apps/**"
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: {
        version: "19.0.0",
      },
    },
    rules: {
      "react/react-in-jsx-scope": "off",
    },
  },
  { files: ["**/*.json"], plugins: { json: jsonPlugin }, language: "json/json", extends: ["json/recommended"] },
  { files: ["**/*.jsonc"], plugins: { json: jsonPlugin }, language: "json/jsonc", extends: ["json/recommended"] },
]);
