export const onMediaChange = (mediaQuery, onChange) => {
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }
  if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }
  return () => {};
};
