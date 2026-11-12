const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

test.use({ javaScriptEnabled: true });

const EVIDENCE_DIR = path.join("test-results", "reviews-carousel");
const REVIEW_COUNT = Number(process.env.TOOLING_REVIEW_COUNT || 0);
const CRUISE = 24;
const DESKTOP = { width: 1440, height: 900 };

const writeEvidence = (name, data) => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
};

const round = (value) => Math.round(value * 100) / 100;

function installProbe() {
  const viewport = () => document.querySelector('[role="region"][aria-label="Player reviews"]');
  const groupWidth = () => viewport().firstElementChild.firstElementChild.scrollWidth;
  const firstCards = () => [...viewport().querySelectorAll('[data-group-index="0"]')];
  const pitch = () => {
    const cards = firstCards();
    return cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : groupWidth();
  };
  const describe = (card, x) => ({
    id: card.dataset.reviewId,
    group: Number(card.dataset.groupIndex),
    offset: x - card.getBoundingClientRect().left,
  });
  const leftEdge = () => {
    const el = viewport();
    const x = el.getBoundingClientRect().left + 1;
    const gap = pitch() - firstCards()[0].offsetWidth;
    for (const card of el.querySelectorAll("[data-review-id]")) {
      const rect = card.getBoundingClientRect();
      if (rect.left <= x && x < rect.right + gap) return describe(card, x);
    }
    return null;
  };
  const cardAt = (x, y) => {
    const card = document.elementFromPoint(x, y)?.closest("[data-review-id]");
    return card ? describe(card, x) : null;
  };
  const state = () => {
    const el = viewport();
    const cards = firstCards();
    return {
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      groupWidth: groupWidth(),
      groups: el.firstElementChild.children.length,
      hiddenGroups: [...el.firstElementChild.children].filter((group) => group.getAttribute("aria-hidden") === "true").length,
      order: cards.map((card) => card.dataset.reviewId),
      cardWidth: cards[0].offsetWidth,
      pitch: pitch(),
      leftEdge: leftEdge(),
    };
  };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const record = (duration) =>
    new Promise((resolve) => {
      const el = viewport();
      const events = [];
      const onEvent = (event) => events.push({ type: event.type, t: event.timeStamp });
      for (const type of ["wheel", "click", "pointerup"]) document.addEventListener(type, onEvent, true);
      const samples = [];
      let start = null;
      const frame = (t) => {
        start ??= t;
        samples.push({ t, s: el.scrollLeft });
        if (t - start < duration) {
          requestAnimationFrame(frame);
          return;
        }
        for (const type of ["wheel", "click", "pointerup"]) document.removeEventListener(type, onEvent, true);
        resolve({ groupWidth: groupWidth(), samples, events });
      };
      requestAnimationFrame(frame);
    });
  let watcher = null;
  const watch = () => {
    const el = viewport();
    const width = groupWidth();
    const order = firstCards().map((card) => card.dataset.reviewId);
    const step = pitch();
    const logical = (edge) => order.indexOf(edge.id) * step + edge.offset;
    const data = {
      groupWidth: width,
      pitch: step,
      scrollEvents: 0,
      frames: 0,
      wraps: [],
      frameWraps: 0,
      minScrollLeft: Infinity,
      maxScrollLeft: -Infinity,
      travel: 0,
      maxFrameJump: 0,
    };
    const track = (value) => {
      data.minScrollLeft = Math.min(data.minScrollLeft, value);
      data.maxScrollLeft = Math.max(data.maxScrollLeft, value);
    };
    let pending = null;
    const before = (event) => {
      if (event.target !== el) return;
      data.scrollEvents += 1;
      pending = { scrollLeft: el.scrollLeft, edge: leftEdge() };
      track(pending.scrollLeft);
    };
    const after = () => {
      if (!pending) return;
      const current = { scrollLeft: el.scrollLeft, edge: leftEdge() };
      track(current.scrollLeft);
      if (Math.abs(current.scrollLeft - pending.scrollLeft) > width / 2) data.wraps.push({ before: pending, after: current });
      pending = null;
    };
    document.addEventListener("scroll", before, true);
    el.addEventListener("scroll", after);
    let lastLogical = logical(leftEdge());
    let lastScroll = el.scrollLeft;
    let frameId = 0;
    const frame = () => {
      const edge = leftEdge();
      track(el.scrollLeft);
      if (Math.abs(el.scrollLeft - lastScroll) > width / 2) data.frameWraps += 1;
      lastScroll = el.scrollLeft;
      if (edge) {
        const value = logical(edge);
        let delta = value - lastLogical;
        delta -= Math.round(delta / width) * width;
        data.travel += delta;
        data.maxFrameJump = Math.max(data.maxFrameJump, Math.abs(delta));
        lastLogical = value;
      }
      data.frames += 1;
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    watcher = {
      data,
      stop: () => {
        cancelAnimationFrame(frameId);
        document.removeEventListener("scroll", before, true);
        el.removeEventListener("scroll", after);
        return data;
      },
    };
  };
  window.__reviewsProbe = {
    state,
    leftEdge,
    cardAt,
    nextFrame,
    record,
    watch,
    travel: () => watcher.data.travel,
    stopWatch: () => watcher.stop(),
  };
}

const probe = (page, method, ...args) =>
  evaluateBrowserTask(page, ([name, values]) => window.__reviewsProbe[name](...values), [method, args]);

const openCarousel = async (page, size = DESKTOP) => {
  await page.setViewportSize(size);
  await page.addInitScript(installProbe);
  await page.goto("/", { waitUntil: "load" });
  const region = page.getByRole("region", { name: "Player reviews" });
  await region.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await expect
    .poll(async () => {
      const current = await probe(page, "state");
      return current.groups >= 3 && current.scrollLeft >= current.groupWidth && current.scrollLeft < current.groupWidth * 2;
    })
    .toBe(true);
  return region;
};

const unwrap = (samples, groupWidth) => {
  let shift = 0;
  return samples.map((sample, index) => {
    if (index > 0) {
      const delta = sample.s - samples[index - 1].s;
      if (delta > groupWidth / 2) shift -= groupWidth;
      if (delta < -groupWidth / 2) shift += groupWidth;
    }
    return { t: sample.t, u: sample.s + shift };
  });
};

const speedOf = (points) => {
  const first = points[0];
  const last = points[points.length - 1];
  return ((last.u - first.u) / (last.t - first.t)) * 1000;
};

const changeTimes = (points) =>
  points.filter((point, index) => index > 0 && Math.abs(point.u - points[index - 1].u) >= 0.5).map((point) => point.t);

const valueAt = (points, time) => {
  let value = points[0].u;
  for (const point of points) {
    if (point.t > time) break;
    value = point.u;
  }
  return value;
};

const firstResumeAfter = (changes, after, minimumGap = 1000) => {
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index] > after && changes[index] - changes[index - 1] >= minimumGap) {
      return { settledAt: changes[index - 1], resumedAt: changes[index] };
    }
  }
  return null;
};

const wheelAcross = async (page, region, direction, groups) => {
  const box = await region.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = await probe(page, "state");
  await probe(page, "watch");
  const target = groups * start.groupWidth;
  let wheelEvents = 0;
  let travel = 0;
  while (Math.abs(travel) < target && wheelEvents < 600) {
    await page.mouse.wheel(direction * 100, 0);
    wheelEvents += 1;
    await page.waitForTimeout(25);
    if (wheelEvents % 5 === 0) travel = await probe(page, "travel");
  }
  await page.waitForTimeout(400);
  const data = await probe(page, "stopWatch");
  const end = await probe(page, "state");
  const identicalWraps = data.wraps.filter(
    (wrap) => wrap.before.edge && wrap.after.edge && wrap.before.edge.id === wrap.after.edge.id && Math.abs(wrap.before.edge.offset - wrap.after.edge.offset) <= 1
  ).length;
  return {
    direction: direction < 0 ? "backward" : "forward",
    viewportWidth: start.clientWidth,
    groupWidth: start.groupWidth,
    groups: start.groups,
    trackWidth: start.scrollWidth,
    requestedWheelPixels: wheelEvents * 100,
    wheelEvents,
    logicalTravel: round(data.travel),
    logicalTravelInGroups: round(data.travel / start.groupWidth),
    scrollEvents: data.scrollEvents,
    frames: data.frames,
    listenerWraps: data.wraps.length,
    frameWraps: data.frameWraps,
    identicalWraps,
    maxFrameJump: round(data.maxFrameJump),
    minScrollLeft: round(data.minScrollLeft),
    maxScrollLeft: round(data.maxScrollLeft),
    minScrollLeftInGroups: round(data.minScrollLeft / start.groupWidth),
    maxScrollLeftInGroups: round(data.maxScrollLeft / start.groupWidth),
    startScrollLeft: round(start.scrollLeft),
    endScrollLeft: round(end.scrollLeft),
    wraps: data.wraps.map((wrap) => ({
      before: { scrollLeft: round(wrap.before.scrollLeft), id: wrap.before.edge?.id, group: wrap.before.edge?.group, offset: round(wrap.before.edge?.offset ?? NaN) },
      after: { scrollLeft: round(wrap.after.scrollLeft), id: wrap.after.edge?.id, group: wrap.after.edge?.group, offset: round(wrap.after.edge?.offset ?? NaN) },
    })),
  };
};

const expectInfinite = (result) => {
  const groupWidth = result.groupWidth;
  expect(Math.abs(result.logicalTravel)).toBeGreaterThanOrEqual(5 * groupWidth);
  expect(result.listenerWraps).toBeGreaterThanOrEqual(4);
  expect(result.identicalWraps).toBe(result.listenerWraps);
  expect(result.maxFrameJump).toBeLessThanOrEqual(150);
  if (result.direction === "backward") {
    expect(Math.sign(result.logicalTravel)).toBe(-1);
    expect(result.minScrollLeft).toBeGreaterThanOrEqual(0.5 * groupWidth);
  } else {
    expect(Math.sign(result.logicalTravel)).toBe(1);
    expect(result.maxScrollLeft).toBeLessThanOrEqual(2.5 * groupWidth);
  }
};

const LEAD_ORDER = ["Vulture", "SkinzOW", "Hydro", "Reviewer 1", "Reviewer 6", "Reviewer 0", "Reviewer 4"];

const visibleReviews = (region) => region.evaluate((el) => {
  const viewport = el.getBoundingClientRect();
  const clear = Number(/rgba\(0, 0, 0, 0\) ([\d.]+)px/.exec(getComputedStyle(el).maskImage)?.[1] || 0);
  return [...el.querySelectorAll("[data-review-id]")]
    .map((card) => ({ id: card.dataset.reviewId, clear, left: card.getBoundingClientRect().left - viewport.left, right: card.getBoundingClientRect().right - viewport.left }))
    .filter((card) => card.right > clear && card.left < viewport.width - clear)
    .sort((a, b) => a.left - b.left);
});

const runInfinite = async (page, region, direction, name) => {
  const result = await wheelAcross(page, region, direction, 5);
  writeEvidence(name, result);
  expectInfinite(result);
  return result;
};

test.describe("review card size", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default seven-review fixture.");

  for (const size of [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 640, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 900 }, { width: 1440, height: 900 }]) {
    test(`size-${size.width}`, async ({ page }) => {
      const region = await openCarousel(page, size);
      const result = await region.evaluate((el) => {
        const cards = [...el.querySelectorAll('[data-group-index="0"]')];
        const style = (element) => getComputedStyle(element);
        const metrics = cards.map((card) => {
          const footer = card.querySelector("footer");
          const avatar = footer.firstElementChild;
          const details = footer.lastElementChild;
          return {
            width: style(card).width,
            padding: style(card).paddingTop,
            radius: style(card).borderTopLeftRadius,
            quote: style(card.querySelector("blockquote p")).fontSize,
            quoteLeading: style(card.querySelector("blockquote p")).lineHeight,
            name: style(details.firstElementChild).fontSize,
            profession: style(details.lastElementChild).fontSize,
            avatarWidth: style(avatar).width,
            avatarHeight: style(avatar).height,
          };
        });
        const spilled = cards.filter((card) => {
          const edge = card.getBoundingClientRect().right + 1;
          return [...card.querySelectorAll("*")]
            .filter((child) => child.getBoundingClientRect().width > 1)
            .some((child) => child.getBoundingClientRect().right > edge);
        }).map((card) => card.dataset.reviewId);
        return {
          metrics,
          tallest: Math.max(...cards.map((card) => card.getBoundingClientRect().height)),
          sectionHeight: el.closest("section").getBoundingClientRect().height,
          sectionTop: style(el.closest("section")).paddingTop,
          headingGap: style(el.closest("section").querySelector(".ri-reviews-heading").parentElement).marginBottom,
          spilled,
        };
      });
      console.log(`size-${size.width}: ${JSON.stringify(result)}`);
      const compact = size.width >= 640;
      const expected = compact
        ? { width: "360px", padding: "12px", radius: "12px", quote: "12px", quoteLeading: "16.2px", name: "13px", profession: "9px", avatarWidth: "32px", avatarHeight: "32px" }
        : { width: "320px", padding: "20px", radius: "16px", quote: "15px", quoteLeading: "22.5px", name: "15px", profession: "13px", avatarWidth: "40px", avatarHeight: "40px" };
      expect(result.metrics.length).toBeGreaterThan(0);
      for (const metrics of result.metrics) expect.soft(metrics).toEqual(expected);
      expect.soft({ sectionTop: result.sectionTop, headingGap: result.headingGap }).toEqual(compact ? { sectionTop: "20px", headingGap: "12px" } : { sectionTop: "24px", headingGap: "32px" });
      if (compact) expect.soft(result.tallest).toBeLessThanOrEqual(200);
      expect.soft(result.spilled).toEqual([]);
    });
  }
});

test.describe("review carousel", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default seven-review fixture.");

  test("rotation-keeps-place", async ({ page }) => {
    await page.clock.install();
    const region = await openCarousel(page, { width: 390, height: 844 });
    const atStart = async (id) => {
      const first = (await visibleReviews(region))[0];
      return first?.id === id && Math.abs(first.left - first.clear - 16) <= 3;
    };
    await expect.poll(() => atStart(LEAD_ORDER[0])).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => atStart(LEAD_ORDER[0])).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => atStart(LEAD_ORDER[0])).toBe(true);
  });

  test("rotation-keeps-place-mid-list", async ({ page }) => {
    await page.clock.install();
    const region = await openCarousel(page, { width: 390, height: 844 });
    const box = await region.boundingBox();
    await page.mouse.move(box.x + 180, box.y + 100);
    await page.mouse.wheel(672, 0);
    await expect.poll(async () => (await visibleReviews(region))[0]?.id).toBe(LEAD_ORDER[2]);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => {
      const first = (await visibleReviews(region))[0];
      return first?.id === LEAD_ORDER[2] && Math.abs(first.left - first.clear - 16) <= 3;
    }).toBe(true);
  });

  test("rotation-after-scroll-back", async ({ page }) => {
    await page.clock.install();
    const region = await openCarousel(page, { width: 390, height: 844 });
    const box = await region.boundingBox();
    const start = await region.evaluate((el) => el.scrollLeft);
    await page.mouse.move(box.x + 180, box.y + 100);
    await page.mouse.wheel(200, 0);
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBe(start + 200);
    await page.mouse.wheel(-200, 0);
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBe(start);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => {
      const first = (await visibleReviews(region))[0];
      return first?.id === LEAD_ORDER[0] && Math.abs(first.left - first.clear - 16) <= 3;
    }).toBe(true);
  });

  test("resize-mid-drag", async ({ page }) => {
    const region = await openCarousel(page, { width: 390, height: 844 });
    const box = await region.boundingBox();
    const x = box.x + 250;
    const y = box.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => {
      const first = (await visibleReviews(region))[0];
      const { pitch } = await probe(page, "state");
      return first?.id === LEAD_ORDER[0] && Math.abs(first.left - first.clear - 16 + (100 / 336) * pitch) <= 2;
    }).toBe(true);
    const before = (await visibleReviews(region))[0];
    await page.mouse.move(x - 101, y);
    const after = (await visibleReviews(region))[0];
    await page.mouse.up();
    expect(after.id).toBe(before.id);
    expect(after.left - before.left).toBeGreaterThanOrEqual(-2);
    expect(after.left - before.left).toBeLessThanOrEqual(0);
  });

  test("resize-mid-arrow", async ({ page }) => {
    await page.clock.install();
    const region = await openCarousel(page, { width: 1024, height: 900 });
    const before = (await visibleReviews(region))[0];
    const start = await probe(page, "state");
    await page.getByRole("button", { name: "Scroll reviews right" }).click();
    await page.clock.runFor(200);
    const middle = await probe(page, "state");
    expect(middle.scrollLeft).toBeGreaterThan(start.scrollLeft);
    expect(middle.scrollLeft).toBeLessThan(start.scrollLeft + start.pitch);
    await page.setViewportSize({ width: 600, height: 900 });
    await page.clock.runFor(600);
    const first = (await visibleReviews(region))[0];
    const { pitch } = await probe(page, "state");
    expect(first.id).toBe(LEAD_ORDER[1]);
    expect(Math.abs((first.left - first.clear - 16) - (before.left - before.clear - 16) * pitch / start.pitch)).toBeLessThanOrEqual(2);
  });

  test("drag-across-regroup", async ({ page }) => {
    await page.addInitScript(() => {
      const NativeResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback) {
          super((entries, observer) => {
            callback(entries, observer);
            const race = window.__regroupRace;
            const viewport = document.querySelector('[role="region"][aria-label="Player reviews"]');
            if (!race?.armed || viewport.clientWidth < 3000) return;
            race.armed = false;
            race.groupsBefore = viewport.firstElementChild.children.length;
            for (const type of ["pointermove", "pointerup"]) {
              viewport.dispatchEvent(new PointerEvent(type, {
                bubbles: true, pointerId: race.pointerId, pointerType: "mouse",
                button: 0, buttons: type === "pointermove" ? 1 : 0,
                clientX: race.x - 200, clientY: race.y,
              }));
            }
            race.groupsAfter = viewport.firstElementChild.children.length;
          });
        }
      };
      document.addEventListener("pointerdown", (event) => {
        window.__lastReviewPointerId = event.pointerId;
      }, true);
    });
    const region = await openCarousel(page, { width: 1024, height: 900 });
    const start = await probe(page, "state");
    const box = await region.boundingBox();
    const x = box.x + 400;
    const y = box.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y);
    await page.evaluate(({ x, y }) => {
      window.__regroupRace = { armed: true, x, y, pointerId: window.__lastReviewPointerId };
    }, { x, y });
    await page.setViewportSize({ width: 3840, height: 900 });
    await expect.poll(() => page.evaluate(() => window.__regroupRace?.armed)).toBe(false);
    const race = await page.evaluate(() => window.__regroupRace);
    expect(race.groupsAfter).toBe(race.groupsBefore);
    await expect.poll(async () => (await probe(page, "state")).groups).toBeGreaterThan(race.groupsBefore);
    const end = await probe(page, "state");
    const logical = (state) => state.order.indexOf(state.leftEdge.id) + state.leftEdge.offset / state.pitch;
    const expected = (logical(start) + 200 / start.pitch) % start.order.length;
    const actual = logical(end);
    const distance = Math.abs(actual - expected);
    expect(Math.min(distance, start.order.length - distance) * end.pitch).toBeLessThanOrEqual(2);
  });

  test("big-widen-keeps-place", async ({ page }) => {
    await page.clock.install();
    const region = await openCarousel(page, { width: 1024, height: 900 });
    const box = await region.boundingBox();
    await page.mouse.move(box.x + 400, box.y + 100);
    await page.mouse.wheel(5 * 376 + 80, 0);
    await expect.poll(async () => (await visibleReviews(region))[0]?.id).toBe(LEAD_ORDER[5]);
    const before = (await visibleReviews(region))[0];
    await page.setViewportSize({ width: 3840, height: 900 });
    await expect.poll(async () => {
      const first = (await visibleReviews(region))[0];
      return first?.id === before.id && Math.abs((first.left - first.clear) - (before.left - before.clear)) <= 3;
    }, { timeout: 1000 }).toBe(true);
  });

  test.describe("recorded", () => {
    let page;
    let recordedContext;

    test.beforeEach(async ({ browser, baseURL }) => {
      recordedContext = await browser.newContext({
        baseURL,
        javaScriptEnabled: true,
        viewport: DESKTOP,
        timezoneId: "UTC",
        recordVideo: { dir: path.join(EVIDENCE_DIR, "video-tmp"), size: DESKTOP },
      });
      const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
      await guardBrowserContext(recordedContext, [baseURL]);
      page = await recordedContext.newPage();
    });

    const saveVideo = async (name) => {
      const video = page.video();
      await recordedContext.close();
      await video.saveAs(path.join(EVIDENCE_DIR, `${name}.webm`));
      await video.delete();
    };

    test.afterEach(async () => {
      await recordedContext.close();
    });

    test("autoplay-moves", async () => {
      const region = await openCarousel(page);
      await page.waitForTimeout(300);
      await region.screenshot({ path: path.join(EVIDENCE_DIR, "autoplay-moves-start.png") });
      const recording = await probe(page, "record", 2000);
      await region.screenshot({ path: path.join(EVIDENCE_DIR, "autoplay-moves-end.png") });
      const points = unwrap(recording.samples, recording.groupWidth);
      const speed = speedOf(points);
      const result = {
        durationMs: round(points[points.length - 1].t - points[0].t),
        startScrollLeft: round(recording.samples[0].s),
        endScrollLeft: round(recording.samples[recording.samples.length - 1].s),
        distancePx: round(points[points.length - 1].u - points[0].u),
        speedPxPerSecond: round(speed),
        cruisePxPerSecond: CRUISE,
        frames: recording.samples.length,
        distinctPositions: new Set(recording.samples.map((sample) => sample.s)).size,
        state: await probe(page, "state"),
      };
      writeEvidence("autoplay-moves", result);
      expect(speed).toBeGreaterThanOrEqual(CRUISE * 0.7);
      expect(speed).toBeLessThanOrEqual(CRUISE * 1.3);
      await saveVideo("autoplay-moves");
    });

    test("drag-across-wrap", async () => {
      const region = await openCarousel(page);
      const start = await probe(page, "state");
      const box = await region.boundingBox();
      await region.evaluate((el, groupWidth) => {
        el.scrollLeft = groupWidth * 2 - 150;
      }, start.groupWidth);
      await page.waitForTimeout(100);
      const y = box.y + box.height / 2;
      let x = box.x + box.width / 2 + 200;
      let pointerCard = await probe(page, "cardAt", x, y);
      while ((!pointerCard || pointerCard.offset < 40 || pointerCard.offset > start.cardWidth - 40) && x > box.x + 600) {
        x -= 10;
        pointerCard = await probe(page, "cardAt", x, y);
      }
      const startScrollLeft = (await probe(page, "state")).scrollLeft;
      await page.mouse.move(x, y);
      await page.mouse.down();
      const steps = [];
      for (let index = 1; index <= 20; index += 1) {
        x -= 20;
        await page.mouse.move(x, y);
        await probe(page, "nextFrame");
        await probe(page, "nextFrame");
        const card = await probe(page, "cardAt", x, y);
        const scrollLeft = (await probe(page, "state")).scrollLeft;
        steps.push({ step: index, pointerX: x, scrollLeft: round(scrollLeft), id: card?.id, group: card?.group, offset: round(card?.offset ?? NaN) });
      }
      const recording = probe(page, "record", 3500);
      await page.waitForTimeout(50);
      await page.mouse.up();
      await region.screenshot({ path: path.join(EVIDENCE_DIR, "drag-across-wrap-released.png") });
      const resume = await recording;
      const points = unwrap(resume.samples, resume.groupWidth);
      const upAt = resume.events.find((event) => event.type === "pointerup").t;
      const firstMove = changeTimes(points).find((time) => time > upAt);
      await region.screenshot({ path: path.join(EVIDENCE_DIR, "drag-across-wrap-end.png") });
      const scrollDrops = steps.filter((step, index) => {
        const previous = index ? steps[index - 1].scrollLeft : startScrollLeft;
        return previous - step.scrollLeft > start.groupWidth / 2;
      }).length;
      const result = {
        groupWidth: start.groupWidth,
        startScrollLeft: round(startScrollLeft),
        pointerCard,
        steps,
        scrollWraps: scrollDrops,
        groupsUnderPointer: [...new Set(steps.map((step) => step.group))],
        maxOffsetDrift: round(Math.max(...steps.map((step) => Math.abs(step.offset - pointerCard.offset)))),
        resumeAfterPointerUpMs: firstMove === undefined ? null : round(firstMove - upAt),
        speedAfterResumePxPerSecond: round(speedOf(points.filter((point) => point.t >= points[points.length - 1].t - 500))),
      };
      writeEvidence("drag-across-wrap", result);
      expect(steps.every((step) => step.id === pointerCard.id)).toBe(true);
      expect(result.maxOffsetDrift).toBeLessThanOrEqual(1.5);
      expect(result.scrollWraps).toBeGreaterThanOrEqual(1);
      expect(result.groupsUnderPointer.length).toBeGreaterThanOrEqual(2);
      expect(result.resumeAfterPointerUpMs).not.toBeNull();
      expect(result.resumeAfterPointerUpMs).toBeGreaterThanOrEqual(1300);
      expect(result.resumeAfterPointerUpMs).toBeLessThanOrEqual(3000);
      await saveVideo("drag-across-wrap");
    });
  });

  test("infinite-backward", async ({ page }) => {
    const region = await openCarousel(page);
    await runInfinite(page, region, -1, "infinite-backward");
  });

  test("infinite-forward", async ({ page }) => {
    const region = await openCarousel(page);
    await runInfinite(page, region, 1, "infinite-forward");
  });

  test("resume-after-wheel", async ({ page }) => {
    const region = await openCarousel(page);
    const box = await region.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const recording = probe(page, "record", 4500);
    await page.waitForTimeout(300);
    await page.mouse.wheel(100, 0);
    const data = await recording;
    const points = unwrap(data.samples, data.groupWidth);
    const wheelAt = data.events.find((event) => event.type === "wheel").t;
    const changes = changeTimes(points);
    const resume = firstResumeAfter(changes, wheelAt);
    const rampDistance = resume ? valueAt(points, resume.resumedAt + 300) - valueAt(points, resume.resumedAt - 1) : null;
    const cruisePoints = resume ? points.filter((point) => point.t >= resume.resumedAt + 1000) : [];
    const result = {
      wheelDeltaX: 100,
      wheelScrollPx: resume ? round(valueAt(points, resume.settledAt) - valueAt(points, wheelAt - 1)) : null,
      wheelSettledAfterMs: resume ? round(resume.settledAt - wheelAt) : null,
      stableMs: resume ? round(resume.resumedAt - resume.settledAt) : null,
      resumedAfterWheelMs: resume ? round(resume.resumedAt - wheelAt) : null,
      first300msDistancePx: rampDistance === null ? null : round(rampDistance),
      cruise300msDistancePx: round((CRUISE * 300) / 1000),
      speedAfterRampPxPerSecond: cruisePoints.length > 2 ? round(speedOf(cruisePoints)) : null,
      speedBeforeWheelPxPerSecond: round(speedOf(points.filter((point) => point.t < wheelAt))),
    };
    writeEvidence("resume-after-wheel", result);
    expect(resume).not.toBeNull();
    expect(result.wheelScrollPx).toBeGreaterThan(0);
    expect(result.stableMs).toBeGreaterThanOrEqual(1200);
    expect(result.resumedAfterWheelMs).toBeLessThanOrEqual(3000);
    expect(result.first300msDistancePx).toBeLessThan(result.cruise300msDistancePx);
    expect(result.speedAfterRampPxPerSecond).toBeGreaterThanOrEqual(CRUISE * 0.7);
    expect(result.speedAfterRampPxPerSecond).toBeLessThanOrEqual(CRUISE * 1.3);
  });

  test("arrow-buttons", async ({ page }) => {
    const region = await openCarousel(page);
    const start = await probe(page, "state");
    const measureClick = async (name) => {
      const button = page.getByRole("button", { name });
      await button.click();
      await page.waitForTimeout(700);
      const recording = probe(page, "record", 3600);
      await page.waitForTimeout(100);
      await button.click();
      const data = await recording;
      const points = unwrap(data.samples, data.groupWidth);
      const clickAt = data.events.find((event) => event.type === "click").t;
      const before = valueAt(points, clickAt);
      const changes = changeTimes(points).filter((time) => time > clickAt);
      const resume = firstResumeAfter([clickAt, ...changes], clickAt, 1000);
      const animationEnd = resume ? resume.settledAt : changes[changes.length - 1];
      const after = valueAt(points, animationEnd);
      const intermediate = points.filter((point) => point.t > clickAt && point.t < animationEnd && point.u !== before && point.u !== after);
      return {
        button: name,
        startScrollLeft: round(before),
        endScrollLeft: round(after),
        movedPx: round(after - before),
        animationMs: changes.length ? round(animationEnd - changes[0]) : null,
        intermediateSamples: intermediate.length,
        resumeAfterAnimationMs: resume ? round(resume.resumedAt - animationEnd) : null,
      };
    };
    const right = await measureClick("Scroll reviews right");
    const left = await measureClick("Scroll reviews left");
    const result = { cardWidth: start.cardWidth, gap: start.pitch - start.cardWidth, pitch: start.pitch, groupWidth: start.groupWidth, right, left };
    writeEvidence("arrow-buttons", result);
    expect(start.pitch).toBe(start.cardWidth + 16);
    for (const [click, sign] of [[right, 1], [left, -1]]) {
      expect(Math.abs(click.movedPx - sign * start.pitch)).toBeLessThanOrEqual(2);
      expect(click.intermediateSamples).toBeGreaterThanOrEqual(5);
      expect(click.resumeAfterAnimationMs).not.toBeNull();
      expect(click.resumeAfterAnimationMs).toBeGreaterThanOrEqual(1300);
      expect(click.resumeAfterAnimationMs).toBeLessThanOrEqual(2300);
    }
  });

  test("reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const region = await openCarousel(page);
    const prefersReduced = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    await page.waitForTimeout(300);
    const recording = await probe(page, "record", 2000);
    const points = unwrap(recording.samples, recording.groupWidth);
    const speed = speedOf(points);
    const start = await probe(page, "state");
    const button = page.getByRole("button", { name: "Scroll reviews right" });
    await page.evaluate(() => {
      const el = document.querySelector('[role="region"][aria-label="Player reviews"]');
      const target = document.querySelector('button[aria-label="Scroll reviews right"]');
      window.__arrowFrames = null;
      target.addEventListener(
        "click",
        () => {
          const before = el.scrollLeft;
          requestAnimationFrame(() => {
            const first = el.scrollLeft;
            requestAnimationFrame(() => {
              const second = el.scrollLeft;
              requestAnimationFrame(() => {
                window.__arrowFrames = { before, first, second, third: el.scrollLeft };
              });
            });
          });
        },
        { capture: true, once: true }
      );
    });
    await button.click();
    await expect.poll(() => page.evaluate(() => window.__arrowFrames)).not.toBeNull();
    const frames = await page.evaluate(() => window.__arrowFrames);
    const wrapDelta = (value) => value - Math.round(value / start.groupWidth) * start.groupWidth;
    const result = {
      prefersReducedMotion: prefersReduced,
      autoplaySpeedPxPerSecond: round(speed),
      autoplayDistancePx: round(points[points.length - 1].u - points[0].u),
      pitch: start.pitch,
      groupWidth: start.groupWidth,
      arrowFrames: Object.fromEntries(Object.entries(frames).map(([key, value]) => [key, round(value)])),
      movedByFirstFramePx: round(wrapDelta(frames.first - frames.before)),
      movedAfterFirstFramePx: round(wrapDelta(frames.third - frames.first)),
    };
    writeEvidence("reduced-motion", result);
    expect(prefersReduced).toBe(true);
    expect(speed).toBeGreaterThanOrEqual(CRUISE * 0.7);
    expect(speed).toBeLessThanOrEqual(CRUISE * 1.3);
    expect(Math.abs(result.movedByFirstFramePx - start.pitch)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.movedAfterFirstFramePx)).toBeLessThanOrEqual(0.5);
  });

  test("mobile-390", async ({ page }) => {
    const region = await openCarousel(page, { width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Scroll reviews left" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Scroll reviews right" })).toBeHidden();
    const spilled = await page.locator(".ri-review-card").evaluateAll((cards) => cards
      .filter((card) => {
        const edge = card.getBoundingClientRect().right + 1;
        return [...card.querySelectorAll("*")]
          .filter((child) => child.getBoundingClientRect().width > 1)
          .some((child) => child.getBoundingClientRect().right > edge);
      })
      .map((card) => card.dataset.reviewId));
    expect(spilled).toEqual([]);
    const backward = await wheelAcross(page, region, -1, 5);
    const forward = await wheelAcross(page, region, 1, 5);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.scrollingElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    writeEvidence("mobile-390", { overflow, backward, forward });
    expectInfinite(backward);
    expectInfinite(forward);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  });

  test("phones-swipe-without-autoplay", async ({ page }) => {
    const region = await openCarousel(page, { width: 390, height: 844 });
    const scrollLeft = () => region.evaluate((el) => el.scrollLeft);
    const phoneStart = await scrollLeft();
    await page.waitForTimeout(2000);
    expect(Math.abs((await scrollLeft()) - phoneStart)).toBeLessThanOrEqual(1);
    const firstCard = await region.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const cards = [...el.querySelectorAll(".ri-review-card")].map((node) => ({ id: node.dataset.reviewId, ...node.getBoundingClientRect().toJSON() }));
      const visible = cards.filter((card) => card.right > viewport.left && card.left < viewport.right).sort((a, b) => a.left - b.left);
      return { ids: visible.map((card) => card.id), left: visible[0].left - viewport.left, right: visible[0].right - viewport.right };
    });
    expect(firstCard.ids[0]).toBe("Vulture");
    expect(Math.abs(firstCard.left - 16)).toBeLessThanOrEqual(1);
    expect(firstCard.right).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 800, height: 900 });
    await expect.poll(async () => {
      const start = await scrollLeft();
      await page.waitForTimeout(600);
      return (await scrollLeft()) - start;
    }, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test("keyboard-focus-drops-fade", async ({ page }) => {
    const region = await openCarousel(page);
    const mask = () => region.evaluate((el) => getComputedStyle(el).maskImage);
    expect(await mask()).toContain("linear-gradient");
    await page.keyboard.press("Shift");
    await region.focus();
    await expect(region).toBeFocused();
    await expect.poll(mask).toBe("none");
    expect(await region.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("Tab");
    await expect.poll(mask).toContain("linear-gradient");
  });

  for (const width of [640, 1024, 1440]) {
    test(`arrows-sit-on-faded-edges-${width}`, async ({ page }) => {
      const region = await openCarousel(page, { width, height: 900 });
      const mask = await region.evaluate((el) => getComputedStyle(el).maskImage);
      const clear = Number(/rgba\(0, 0, 0, 0\) ([\d.]+)px/.exec(mask)?.[1]);
      const edges = await region.boundingBox();
      const left = await page.getByRole("button", { name: "Scroll reviews left" }).boundingBox();
      const right = await page.getByRole("button", { name: "Scroll reviews right" }).boundingBox();
      expect(left.x + left.width - edges.x, mask).toBeLessThanOrEqual(clear);
      expect(edges.x + edges.width - right.x, mask).toBeLessThanOrEqual(clear);
    });
  }

  test("idle-frames-offscreen", async ({ page }) => {
    await page.addInitScript(() => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.__rafCount = 0;
      window.requestAnimationFrame = (callback) => {
        window.__rafCount += 1;
        return requestFrame(callback);
      };
    });
    const region = await openCarousel(page);
    await page.waitForTimeout(500);
    const rafCount = () => page.evaluate(() => window.__rafCount);
    const scrollLeft = () => region.evaluate((el) => el.scrollLeft);
    const placement = () =>
      region.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, innerHeight: window.innerHeight, scrollY: window.scrollY };
      });

    const visibleStart = await rafCount();
    const visibleScrollStart = await scrollLeft();
    await page.waitForTimeout(1000);
    const visibleRate = (await rafCount()) - visibleStart;
    const visibleScrollEnd = await scrollLeft();

    await page.evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: "instant" }));
    const hiddenPlacement = await placement();
    const fullyHidden = hiddenPlacement.bottom <= 0 || hiddenPlacement.top >= hiddenPlacement.innerHeight;
    await page.waitForTimeout(400);
    const hiddenStart = await rafCount();
    const hiddenScrollStart = await scrollLeft();
    await page.waitForTimeout(1000);
    const hiddenRate = (await rafCount()) - hiddenStart;
    const hiddenScrollEnd = await scrollLeft();

    await region.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    const shownPlacement = await placement();
    const { groupWidth } = await probe(page, "state");
    const resumeStart = await scrollLeft();
    const shownAt = Date.now();
    let resumedMs = null;
    let resumedDelta = 0;
    while (Date.now() - shownAt <= 2000) {
      const delta = (await scrollLeft()) - resumeStart;
      resumedDelta = delta - Math.round(delta / groupWidth) * groupWidth;
      if (resumedDelta >= 5) {
        resumedMs = Date.now() - shownAt;
        break;
      }
      await page.waitForTimeout(50);
    }

    const result = {
      visibleRate,
      visibleScrollStart: round(visibleScrollStart),
      visibleScrollEnd: round(visibleScrollEnd),
      hiddenPlacement: Object.fromEntries(Object.entries(hiddenPlacement).map(([key, value]) => [key, round(value)])),
      fullyHidden,
      hiddenRate,
      hiddenScrollStart: round(hiddenScrollStart),
      hiddenScrollEnd: round(hiddenScrollEnd),
      shownPlacement: Object.fromEntries(Object.entries(shownPlacement).map(([key, value]) => [key, round(value)])),
      groupWidth,
      resumeStartScrollLeft: round(resumeStart),
      resumedDeltaPx: round(resumedDelta),
      resumedAfterMs: resumedMs,
    };
    writeEvidence("idle-frames-offscreen", result);
    expect(visibleRate).toBeGreaterThanOrEqual(50);
    expect(fullyHidden).toBe(true);
    expect(hiddenRate).toBeLessThanOrEqual(10);
    expect(hiddenScrollEnd).toBe(hiddenScrollStart);
    expect(resumedMs).not.toBeNull();
    expect(resumedDelta).toBeGreaterThanOrEqual(5);
  });
});

test.describe("review carousel with two reviews", () => {
  test.skip(REVIEW_COUNT !== 2, "Run with TOOLING_REVIEW_COUNT=2.");

  test("two-reviews-fill", async ({ page }) => {
    const region = await openCarousel(page);
    const start = await probe(page, "state");
    const backward = await wheelAcross(page, region, -1, 5);
    const forward = await wheelAcross(page, region, 1, 5);
    writeEvidence("two-reviews-fill", {
      reviews: start.order,
      groups: start.groups,
      groupWidth: start.groupWidth,
      trackWidth: start.scrollWidth,
      viewportWidth: start.clientWidth,
      trackToViewportRatio: round(start.scrollWidth / start.clientWidth),
      backward,
      forward,
    });
    expect(start.order).toHaveLength(2);
    expect(start.scrollWidth).toBeGreaterThanOrEqual(3 * start.clientWidth);
    expectInfinite(backward);
    expectInfinite(forward);
  });
});

test.describe("review carousel order", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default seven-review fixture.");

  for (const size of [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 900 }, { width: 1440, height: 900 }]) {
    test(`visible-order-${size.width}`, async ({ page }) => {
      const region = await openCarousel(page, size);
      const ids = (await visibleReviews(region)).map((card) => card.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual(LEAD_ORDER.slice(0, ids.length));
    });
  }
});

test.describe("review carousel without JavaScript", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default seven-review fixture.");
  test.use({ javaScriptEnabled: false });

  test("no-js-static", async ({ page, request }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/", { waitUntil: "load" });
    const html = await (await request.get("/")).text();
    const region = page.getByRole("region", { name: "Player reviews" });
    const firstCopy = region.locator('[data-group-index="0"]');
    const result = {
      htmlFirstCopyCards: (html.match(/data-group-index="0"/g) || []).length,
      htmlCopyCards: (html.match(/data-group-index="[1-9]/g) || []).length,
      htmlReviewIds: [...html.matchAll(/data-review-id="([^"]+)"/g)].map((match) => match[1]),
      renderedFirstCopyCards: await firstCopy.count(),
      firstCardVisible: await firstCopy.first().isVisible(),
      firstCardText: (await firstCopy.first().innerText()).slice(0, 120),
    };
    writeEvidence("no-js-static", result);
    expect(result.htmlFirstCopyCards).toBe(7);
    expect(result.htmlReviewIds).toEqual(LEAD_ORDER);
    expect(result.renderedFirstCopyCards).toBe(7);
    expect(result.firstCardVisible).toBe(true);
    for (const size of [{ width: 390, height: 844 }, DESKTOP]) {
      await page.setViewportSize(size);
      await region.scrollIntoViewIfNeeded();
      const cards = await visibleReviews(region);
      const ids = cards.map((card) => card.id);
      expect(ids[0], `${size.width}px`).toBe("Vulture");
      expect(cards[0].left, `${size.width}px`).toBeGreaterThanOrEqual(cards[0].clear);
      expect(ids, `${size.width}px`).toEqual(LEAD_ORDER.slice(0, ids.length));
    }
  });
});

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});
