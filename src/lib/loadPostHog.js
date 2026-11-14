import { isProductionBrowser } from "./productionBrowser";

export const loadPostHog = () => {
  if (isProductionBrowser()) import("./posthog").then(({ startPostHogWhenIdle }) => startPostHogWhenIdle()).catch(() => {});
};
