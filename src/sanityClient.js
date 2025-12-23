import { createClient } from "@sanity/client";
import imageUrlBuilder from "@sanity/image-url";

export const client = createClient({
  projectId: "9g42k3ur",
  dataset: "production",
  apiVersion: "2023-10-01",
  useCdn: true,
  token: process.env.REACT_APP_SANITY_WRITE_TOKEN,
});

const builder = imageUrlBuilder(client);
export const urlFor = (source) => builder.image(source);

const isReactSnap =
  typeof navigator !== "undefined" && navigator.userAgent === "ReactSnap";

if (isReactSnap && typeof window !== "undefined") {
  if (!window.__PRERENDER_PENDING__) {
    window.__PRERENDER_PENDING__ = new Set();
  }

  // CRA uses react-snap for prerender; wait for Sanity requests before snapshotting.
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
}

const originalFetch = client.fetch.bind(client);
client.fetch = (...args) => {
  const promise = originalFetch(...args);
  if (
    isReactSnap &&
    typeof window !== "undefined" &&
    window.__PRERENDER_PENDING__
  ) {
    window.__PRERENDER_PENDING__.add(promise);
    const cleanup = () => window.__PRERENDER_PENDING__.delete(promise);
    promise.then(cleanup).catch(cleanup);
  }
  return promise;
};
