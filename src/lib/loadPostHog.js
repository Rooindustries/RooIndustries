import { isProductionBrowser } from "./productionBrowser";

export const loadPostHog = () => {
  if (isProductionBrowser()) import("./posthog").then(({ syncPostHogPage, startPostHogWhenIdle }) => {
    syncPostHogPage();
    startPostHogWhenIdle();
  }).catch(() => {});
};
