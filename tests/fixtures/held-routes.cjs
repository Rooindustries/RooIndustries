const { expect } = require("@playwright/test");

const pageRoutes = new WeakMap();
const removeContextRoutes = (context, pattern, handler) => context.unroute(pattern, handler);

const routePage = async (page, pattern, callback) => {
  const context = page.context();
  const inFlight = new Set();
  const handler = async route => {
    const handling = (async () => {
      const request = route.request();
      if (request.frame().page() !== page) return route.fallback();
      await callback(route, request);
    })();
    inFlight.add(handling);
    try {
      await handling;
    } finally {
      inFlight.delete(handling);
    }
  };
  const registrations = pageRoutes.get(page) || new Set();
  pageRoutes.set(page, registrations);
  let removing;
  const registration = {
    pattern,
    callback,
    remove: () => {
      removing ||= (async () => {
        await removeContextRoutes(context, pattern, handler);
        await Promise.all(inFlight);
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

module.exports = { holdRoutes, routePage, removePageRoutes, removeContextRoutes };
