({ first, second, painted }) => {
  const state = { dispatched: false };
  const hash = new URL(document.querySelector(first).href).hash;
  const observer = new MutationObserver(() => {
    if (!document.querySelector("#services")) return;
    observer.disconnect();
    const click = () => {
      state.dispatched = true;
      document.querySelector(second).click();
    };
    if (painted) {
      const clickWhenVisible = () => {
        const section = document.getElementById(hash.slice(1));
        const veil = document.querySelector(".route-transition-veil");
        if (location.pathname === "/" && location.hash === hash && section?.checkVisibility() &&
            Math.abs(section.getBoundingClientRect().top) <= 160 &&
            !document.documentElement.classList.contains("route-transition-lock") &&
            veil && getComputedStyle(veil).opacity === "0") {
          click();
          return;
        }
        state.frame = requestAnimationFrame(clickWhenVisible);
      };
      state.frame = requestAnimationFrame(clickWhenVisible);
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
