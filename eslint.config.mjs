import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import roo, { rules } from "./eslint-rules/index.mjs";

const emailTextRules = new Set(["no-hand-built-dollars"]);
const testFiles = "src/**/__tests__/**";
const ruleSet = (names) => Object.fromEntries(names.map((name) => [`roo/${name}`, "error"]));

export default [
  {
    files: ["src/**/*.{js,jsx,mjs,cjs}", "app/**/*.{js,jsx,mjs,cjs}", "middleware.js"],
    ignores: [testFiles],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { roo, "react-hooks": reactHooks },
    rules: ruleSet(Object.keys(rules).filter((name) => !emailTextRules.has(name))),
  },
  {
    files: [`${testFiles}/*.{js,jsx,mjs,cjs}`],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node, ...globals.jest },
    },
    plugins: { roo },
    rules: ruleSet(["no-virtual-mock-of-installed-module"]),
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "tests/**/*.{js,mjs,cjs}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    plugins: { roo },
    rules: ruleSet(["no-hand-built-node-options"]),
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    files: ["src/server/email/**/*.{js,mjs}", "src/server/api/ref/*[Ee]mail*.js"],
    rules: ruleSet([...emailTextRules]),
  },
  {
    files: ["src/components/BookingForm.jsx"],
    rules: { "roo/no-client-only-public-content": "off" },
  },
];
