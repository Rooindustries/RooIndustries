({ first, second, painted }) => {
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
}
