const waitForTargetSettle = (page, hash, timeoutMs, offsetMax) =>
  page.evaluate(async ({ hash, timeoutMs, offsetMax }) => {
    const start = performance.now();
    let top = null;
    let lastTop = null;
    let stableSince = null;
    while (performance.now() - start <= timeoutMs) {
      const target = document.querySelector(hash);
      top = target ? Math.round(target.getBoundingClientRect().top) : null;
      if (top !== null && Math.abs(top) <= offsetMax) {
        if (stableSince === null || lastTop === null || Math.abs(top - lastTop) > 1) stableSince = performance.now();
        if (performance.now() - stableSince >= 150) return { ok: true, timeToTargetMs: Math.round(performance.now() - start), top };
      } else {
        stableSince = null;
      }
      lastTop = top;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ok: false, timeToTargetMs: Math.round(performance.now() - start), top };
  }, { hash, timeoutMs, offsetMax });

const waitForHash = (page, expectedHash, timeoutMs) =>
  page.evaluate(async ({ expectedHash, timeoutMs }) => {
    const start = performance.now();
    while (performance.now() - start <= timeoutMs) {
      if (window.location.hash === expectedHash) return { ok: true, latencyMs: Math.round(performance.now() - start) };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }, { expectedHash, timeoutMs });

module.exports = { waitForTargetSettle, waitForHash };
