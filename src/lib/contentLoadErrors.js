let pageLeft = false;

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageLeft = true;
  });
  window.addEventListener("pageshow", () => {
    pageLeft = false;
  });
}

export const reportContentLoadError = (...details) => {
  if (pageLeft) return;
  console.error(...details);
};
