({ first, second, path }) => new Promise((resolve, reject) => {
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
})
