const watchHomeArrival = ({ first, second, painted }) => {
  const state = { dispatched: false };
  const observer = new MutationObserver(() => {
    if (!document.querySelector("#services")) return;
    observer.disconnect();
    const click = () => {
      state.dispatched = true;
      document.querySelector(second).click();
    };
    if (painted) {
      state.frame = requestAnimationFrame(() => { state.frame = requestAnimationFrame(click); });
    } else {
      click();
    }
  });
  window.__homeArrivalClick = {
    state,
    stop: () => {
      observer.disconnect();
      cancelAnimationFrame(state.frame);
    },
  };
  observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
  document.querySelector(first).click();
};

const clickAtCommittedRoute = ({ first, second, path }) => new Promise((resolve, reject) => {
  const observer = new MutationObserver(() => {
    if (!document.querySelector(`#main-content [data-route-key="${path}"]`)) return;
    if (path === "/" && !document.querySelector("#services")) return;
    observer.disconnect();
    clearTimeout(timeout);
    document.querySelector(second).click();
    resolve();
  });
  const timeout = setTimeout(() => {
    observer.disconnect();
    reject(new Error(`Missing committed route ${path}`));
  }, 15000);
  observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
  document.querySelector(first).click();
});

module.exports = { watchHomeArrival, clickAtCommittedRoute };
