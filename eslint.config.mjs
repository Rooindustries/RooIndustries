import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import roo, { rules } from "./eslint-rules/index.mjs";

const emailTextRules = new Set(["no-hand-built-dollars"]);
const scriptRules = new Set(["no-parent-ipc-disconnect", "no-unchecked-group-signal", "no-linux-only-test-tooling"]);
const navigationRules = new Set(["no-secure-context-navigation-keys"]);
const testFiles = "src/**/__tests__/**";
const ruleSet = (names) => Object.fromEntries(names.map((name) => [`roo/${name}`, "error"]));

export default [
  {
    files: ["src/server/api/payment/**/*.js"],
    ignores: ["src/server/api/payment/providerPaymentState.js"],
    rules: { "no-restricted-syntax": ["error", {
      selector: "Literal[value=/^9999-/]",
      message: "Keep payment recovery dates bounded with getNextPaymentRecoveryAt.",
    }] },
  },
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
    rules: ruleSet(Object.keys(rules).filter((name) =>
      !emailTextRules.has(name) && !scriptRules.has(name) && !navigationRules.has(name)
    )),
  },
  {
    files: ["src/lib/sectionNavigator.jsx"],
    rules: { ...ruleSet([...navigationRules]), "react-hooks/refs": "error" },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "tests/**/*.{js,mjs,cjs}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    plugins: { roo },
    rules: ruleSet(["no-hand-built-node-options", "no-unchecked-group-signal"]),
  },
  {
    files: [
      "scripts/lib/**/*.{js,mjs,cjs}",
      "scripts/test-*-server.mjs",
      "scripts/sourcemaps-e2e.mjs",
      "scripts/monitoring-deployment-e2e.mjs",
    ],
    rules: ruleSet(["no-linux-only-test-tooling"]),
  },
  {
    files: ["scripts/lib/process-group.mjs"],
    rules: { "roo/no-unchecked-group-signal": "off" },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "tests/fixtures/**/*.{js,mjs,cjs}"],
    plugins: { roo },
    rules: ruleSet(["no-parent-ipc-disconnect"]),
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
