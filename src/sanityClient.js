import { createClient } from "@sanity/client";
import { createImageUrlBuilder } from "@sanity/image-url";

export const client = createClient({
  projectId: "9g42k3ur",
  dataset: "production",
  apiVersion: "2023-10-01",
  useCdn: true,
  token: process.env.REACT_APP_SANITY_WRITE_TOKEN,
});

const builder = createImageUrlBuilder(client);
export const urlFor = (source) => builder.image(source);

const isPrerender =
  (typeof navigator !== "undefined" && navigator.userAgent === "ReactSnap") ||
  (typeof window !== "undefined" && window.__PRERENDER__ === true);

const notifyPrerenderReady = () => {
  if (typeof window === "undefined") return;
  if (!window.__PRERENDER__) return;
  if (window.__PRERENDER_READY__) return;
  if (window.__PRERENDER_PENDING__?.size) return;

  window.__PRERENDER_READY__ = true;
  document.dispatchEvent(new Event("prerender-ready"));
};

if (isPrerender && typeof window !== "undefined") {
  if (!window.__PRERENDER_PENDING__) {
    window.__PRERENDER_PENDING__ = new Set();
  }

  // Wait for Sanity requests before snapshotting or jsdom prerender.
  if (!window.snapSaveState) {
    window.snapSaveState = () =>
      new Promise((resolve) => {
        const start = Date.now();
        const maxWaitMs = 15000;
        const check = () => {
          if (window.__PRERENDER_PENDING__.size === 0) {
            resolve();
            return;
          }
          if (Date.now() - start > maxWaitMs) {
            resolve();
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
  }

  setTimeout(notifyPrerenderReady, 0);
}

const originalFetch = client.fetch.bind(client);
client.fetch = (...args) => {
  const promise = originalFetch(...args);
  if (
    isPrerender &&
    typeof window !== "undefined" &&
    window.__PRERENDER_PENDING__
  ) {
    window.__PRERENDER_PENDING__.add(promise);
    const cleanup = () => {
      window.__PRERENDER_PENDING__.delete(promise);
      notifyPrerenderReady();
    };
    promise.then(cleanup).catch(cleanup);
  }
  return promise;
};
