const { expect } = require("@playwright/test");

const holdRoutes = async (page, pattern, shouldHold = () => true) => {
  const context = page.context();
  const requests = [];
  const inFlight = new Set();
  let resume;
  const released = new Promise(resolve => { resume = resolve; });
  const handler = async route => {
    const handling = (async () => {
      const request = route.request();
      if (request.frame().page() === page && await shouldHold(request)) {
        requests.push(request);
        await released;
      }
      await route.fallback();
    })();
    inFlight.add(handling);
    try {
      await handling;
    } finally {
      inFlight.delete(handling);
    }
  };
  await context.route(pattern, handler);
  let releasing;
  return {
    requests,
    wait: () => expect.poll(() => requests.length, { timeout: 8000 }).toBeGreaterThan(0),
    release: () => {
      releasing ||= (async () => {
        resume();
        await context.unroute(pattern, handler);
        await Promise.all(inFlight);
      })();
      return releasing;
    },
  };
};

module.exports = { holdRoutes };
