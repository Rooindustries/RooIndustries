let pageLeft = false;

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageLeft = true;
  });
  window.addEventListener("pageshow", () => {
    pageLeft = false;
  });
}

const fetchFailureMessages = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

const isCancelledRequest = (detail) =>
  detail?.name === "AbortError" ||
  (pageLeft && detail instanceof TypeError && fetchFailureMessages.has(detail.message));

export const reportContentLoadError = (...details) => {
  if (details.some(isCancelledRequest)) return;
  console.error(...details);
};
