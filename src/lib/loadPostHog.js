import { isProductionBrowser } from "./productionBrowser";

let poppedAt = 0;
let postHogLoaded = false;
if (typeof window !== "undefined") window.addEventListener("popstate", () => { poppedAt = Date.now(); });

export const lastPopstate = () => poppedAt;

const withPostHog = (action) => {
  if (!isProductionBrowser()) return;
  import("./consent")
    .then(({ readConsent }) => (postHogLoaded || readConsent() === "granted") && import("./posthog"))
    .then((posthog) => {
      if (!posthog) return;
      postHogLoaded = true;
      action(posthog);
    })
    .catch(() => {});
};

export const loadPostHog = () => withPostHog(({ syncPostHogPage, startPostHogWhenIdle }) => {
  syncPostHogPage();
  startPostHogWhenIdle();
});

export const capturePostHogEvent = (eventName, properties, origin) =>
  withPostHog(({ capturePostHog }) => capturePostHog(eventName, properties, origin));
