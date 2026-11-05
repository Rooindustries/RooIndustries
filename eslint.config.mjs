import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import roo, { rules } from "./eslint-rules/index.mjs";

const emailTextRules = new Set(["no-hand-built-dollars"]);
const scriptRules = new Set(["no-parent-ipc-disconnect", "no-unchecked-group-signal"]);
const ruleSet = (names) => Object.fromEntries(names.map((name) => [`roo/${name}`, "error"]));

export default [
  { ignores: ["src/**/__tests__/**"] },
  {
    files: ["src/**/*.{js,jsx,mjs,cjs}", "app/**/*.{js,jsx,mjs,cjs}", "middleware.js"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { roo, "react-hooks": reactHooks },
    rules: ruleSet(Object.keys(rules).filter((name) => !emailTextRules.has(name) && !scriptRules.has(name))),
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "tests/**/*.{js,mjs,cjs}"],
    ignores: ["scripts/lib/process-group.mjs"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    plugins: { roo },
    rules: ruleSet(["no-unchecked-group-signal"]),
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "tests/fixtures/**/*.{js,mjs,cjs}"],
    plugins: { roo },
    rules: ruleSet(["no-parent-ipc-disconnect"]),
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
