const { execSync } = require("child_process");

// CRA build: prerender marketing routes after build using a jsdom renderer.
const resolvedVercelEnv =
  process.env.VERCEL_ENV ||
  process.env.REACT_APP_VERCEL_ENV ||
  "production";

const env = {
  ...process.env,
  CI: "false",  // Force CI=false to treat ESLint warnings as warnings, not errors
  REACT_APP_VERCEL_ENV: resolvedVercelEnv,
};

if (!env.REACT_APP_SITE_URL && process.env.SITE_URL) {
  env.REACT_APP_SITE_URL = process.env.SITE_URL;
}

execSync("react-scripts build", {
  stdio: "inherit",
  env,
});
