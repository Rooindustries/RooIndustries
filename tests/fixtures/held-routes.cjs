const { randomUUID } = require("node:crypto");
const { fixturePort } = require("./fixture-ports.cjs");

const owners = new WeakMap();

const ownerOf = (target) => {
  const owner = owners.get(target);
  if (!owner) throw new Error("Held routes need the heldRoutes fixture.");
  return owner;
};

const heldRouteFixtures = {
  heldRoutes: [async ({ page, context }, use) => {
    const owner = { open: true, answering: new Set() };
    owner.ended = new Promise((resolve) => {
      owner.end = () => {
        owner.open = false;
        resolve();
      };
    });
    page.once("close", owner.end);
    owners.set(page, owner);
    owners.set(context, owner);
    await use(owner);
    owner.end();
    await Promise.allSettled(owner.answering);
  }, { auto: true }],
};

const ownRoute = (target, url, handle, options) => {
  const owner = ownerOf(target);
  const live = async (gate) => {
    await Promise.race([gate, owner.ended]);
    return owner.open;
  };
  return target.route(url, (route) => {
    if (!owner.open) return undefined;
    const answer = handle(route, live);
    owner.answering.add(answer);
    return answer.finally(() => owner.answering.delete(answer));
  }, options);
};

const newHold = () => {
  const hold = { held: false };
  hold.gate = new Promise((resolve) => { hold.release = resolve; });
  return hold;
};

const holdRoute = async (target, url, answer, options) => {
  const hold = newHold();
  await ownRoute(target, url, async (route, live) => {
    hold.held = true;
    if (await live(hold.gate)) await answer(route);
  }, options);
  return hold;
};

const inspectChunks = (page, { origin, fetchOrigin = origin }, wait, answer = (route, response, body) =>
  route.fulfill({ response, body })) =>
  ownRoute(page, `${origin}/_next/static/chunks/**`, async (route, live) => {
    const response = await route.fetch({ url: route.request().url().replace(origin, fetchOrigin) });
    const body = await response.body();
    if (await live(wait(body))) await answer(route, response, body);
  });

const holdChunks = async (page, origins, matches) => {
  const hold = newHold();
  await inspectChunks(page, origins, (body) => {
    if (!matches(body)) return undefined;
    hold.held = true;
    return hold.gate;
  }, (route, response, body) => {
    if (matches(body)) hold.answered = true;
    return route.fulfill({ response, body });
  });
  return hold;
};

const holdChunksOnServer = async (page, origins, matches) => {
  const id = randomUUID();
  const path = `/ingest/static/held-${id}.js`;
  await page.route(`**${path}`, (route) => route.continue());
  await inspectChunks(page, origins, () => undefined, (route, response, body) =>
    matches(body) ? route.fulfill({ status: 302, headers: { location: path }, body: "" })
      : route.fulfill({ response, body }));
  return {
    held: async () => {
      const url = `http://127.0.0.1:${fixturePort("TOOLING_CONTENT_PORT")}/__held_posthog?id=${id}`;
      const response = await fetch(url);
      return (await response.json()).held;
    },
  };
};

module.exports = { heldRouteFixtures, holdRoute, inspectChunks, holdChunks, holdChunksOnServer };
