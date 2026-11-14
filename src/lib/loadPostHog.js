import { isProductionBrowser } from "./productionBrowser";

let poppedAt = 0;
if (typeof window !== "undefined") window.addEventListener("popstate", () => { poppedAt = Date.now(); });

export const lastPopstate = () => poppedAt;

export const loadPostHog = () => {
  if (isProductionBrowser()) import("./posthog").then(({ syncPostHogPage, startPostHogWhenIdle }) => {
    syncPostHogPage();
    startPostHogWhenIdle();
  }).catch(() => {});
};
