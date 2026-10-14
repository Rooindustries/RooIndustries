export const setVisibleTimeout = (callback, ms) => {
  let timer = 0;
  let remaining = ms;
  let startedAt = 0;
  let fired = false;
  const sync = () => {
    if (fired) return;
    if (document.visibilityState === "visible") {
      if (timer) return;
      startedAt = performance.now();
      timer = window.setTimeout(() => {
        fired = true;
        callback();
      }, remaining);
    } else if (timer) {
      window.clearTimeout(timer);
      timer = 0;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
    }
  };
  document.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    document.removeEventListener("visibilitychange", sync);
    window.clearTimeout(timer);
  };
};
