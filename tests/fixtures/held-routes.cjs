const { expect } = require("@playwright/test");

const pageRoutes = new WeakMap();
const terminalMethods = new Set(["abort", "continue", "fallback", "fulfill"]);

const routePage = async (page, pattern, callback) => {
  const context = page.context();
  const inFlight = new Set();
  let removed = false;
  const handler = async route => {
    const request = route.request();
    let requestPage;
    try { requestPage = request.frame().page(); } catch { return route.fallback(); }
    if (removed || requestPage !== page) return route.fallback();
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const failed = failedRequest => { if (failedRequest === request) finish(); };
    context.on("requestfailed", failed);
    const tracked = new Proxy(route, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        if (!terminalMethods.has(property)) return value.bind(target);
        return (...args) => Promise.resolve(value.apply(target, args)).finally(finish);
      },
    });
    const handling = (async () => {
      try {
        await callback(tracked, request);
        await finished;
      } finally {
        context.off("requestfailed", failed);
      }
    })();
    inFlight.add(handling);
    try { await handling; } finally { inFlight.delete(handling); }
  };
  const registrations = pageRoutes.get(page) || new Set();
  pageRoutes.set(page, registrations);
  let removing;
  const registration = {
    pattern,
    callback,
    remove: () => {
      removing ||= (async () => {
        removed = true;
        await Promise.all(inFlight);
        await context.unroute(pattern, handler);
        registrations.delete(registration);
      })();
      return removing;
    },
  };
  await context.route(pattern, handler);
  registrations.add(registration);
  return registration.remove;
};

const removePageRoutes = (page, pattern, callback) => Promise.all(
  [...(pageRoutes.get(page) || [])]
    .filter(entry => (pattern === undefined || entry.pattern === pattern) &&
      (callback === undefined || entry.callback === callback))
    .map(entry => entry.remove())
);

const holdRoutes = async (page, pattern, shouldHold = () => true) => {
  const requests = [];
  let resume;
  const released = new Promise(resolve => { resume = resolve; });
  const remove = await routePage(page, pattern, async (route, request) => {
    if (await shouldHold(request)) {
      requests.push(request);
      await released;
    }
    await route.fallback();
  });
  let releasing;
  return {
    requests,
    wait: () => expect.poll(() => requests.length, { timeout: 8000 }).toBeGreaterThan(0),
    release: () => {
      releasing ||= (async () => {
        resume();
        await remove();
      })();
      return releasing;
    },
  };
};

module.exports = { holdRoutes, routePage, removePageRoutes };
