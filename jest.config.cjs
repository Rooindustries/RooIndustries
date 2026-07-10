const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

module.exports = createJestConfig({
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    customExportConditions: ["node", "node-addons"],
  },
  setupFilesAfterEnv: ["<rootDir>/src/setupTests.js"],
  testMatch: ["<rootDir>/src/**/__tests__/**/*.[jt]s?(x)"],
  testPathIgnorePatterns: ["<rootDir>/.next/", "<rootDir>/node_modules/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
});
