export const reportContentLoadError = (...details) => {
  if (details.some((detail) => detail?.requestCancelled === true)) return;
  console.error(...details);
};
