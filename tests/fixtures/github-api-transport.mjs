import { installNetworkGuard, localOrigin } from "../../scripts/lib/test-target-safety.mjs";

const origin = localOrigin(process.env.ROO_GITHUB_FIXTURE_ORIGIN);
installNetworkGuard([origin]);
const guardedFetch = globalThis.fetch;

globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (url.origin !== "https://api.github.com") throw new Error("Only the fixture GitHub API is allowed.");
  return guardedFetch(`${origin}${url.pathname}${url.search}`, options);
};
