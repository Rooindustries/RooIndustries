const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");
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
  const opening = { painted: null, positioned: null };
  const snapshot = (el) => {
    const view = el.getBoundingClientRect();
    const stops = [...getComputedStyle(el).maskImage.matchAll(/([\d.]+)px/g)].map((match) => Number(match[1]));
    return {
      scrollLeft: el.scrollLeft,
      groupWidth: el.firstElementChild.firstElementChild.scrollWidth,
      groups: el.firstElementChild.children.length,
      width: view.width,
      clear: stops[0] ?? 0,
      fade: stops[1] ?? 0,
      cards: [...el.querySelectorAll(".ri-review-card")].map((card) => {
        const rect = card.getBoundingClientRect();
        return { id: card.dataset.reviewId, left: rect.left - view.left, right: rect.right - view.left };
      }),
    };
  };
  const isPositioned = (el) =>
    el.firstElementChild.children.length >= 3 && el.scrollLeft >= el.firstElementChild.firstElementChild.scrollWidth - 1;
  const onFirstPosition = (event) => {
    const el = viewport();
    if (event.target !== el || !isPositioned(el)) return;
    opening.positioned = snapshot(el);
    document.removeEventListener("scroll", onFirstPosition, true);
  };
  document.addEventListener("scroll", onFirstPosition, true);
  const onFirstPaint = () => {
    const el = viewport();
    if (el?.querySelector(".ri-review-card")) {
      opening.painted = snapshot(el);
      return;
    }
    requestAnimationFrame(onFirstPaint);
  };
  requestAnimationFrame(onFirstPaint);
  window.__reviewsProbe = {
    opening: () => opening,
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

const stripContainerQueries = (css) =>
  css
    .replace(/(\d)cq(?:i|b|w|h|min|max)\b/g, "$1xq")
    .replace(/([{;]\s*)(container(?:-type|-name)?\s*:)/g, "$1x-$2")
    .replace(/@container\b/g, "@x-container");

const loadWithoutContainerQueries = async (page) => {
  const rewritten = [];
  await page.route(/\.css(\?|$)/, async (route) => {
    const response = await route.fetch();
    const css = await response.text();
    rewritten.push(route.request().url());
    await route.fulfill({ response, body: stripContainerQueries(css) });
  });
  return rewritten;
};

const containerQueryRules = (page) =>
  page.evaluate(() => {
    const found = [];
    const walk = (rules) => {
      for (const rule of rules) {
        if (/\dcq(?:i|b|w|h|min|max)\b|container-type|@container/.test(rule.cssText)) found.push(rule.cssText.slice(0, 80));
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch {
        found.push(`unreadable ${sheet.href}`);
      }
      if (rules) walk(rules);
    }
    return found;
  });

const openCarousel = async (page, size = DESKTOP, { containerQueries = true } = {}) => {
  await page.setViewportSize(size);
  await page.addInitScript(installProbe);
  const rewritten = containerQueries ? null : await loadWithoutContainerQueries(page);
  await page.goto("/", { waitUntil: "load" });
  if (rewritten) {
    expect(rewritten.length).toBeGreaterThan(0);
    expect(await containerQueryRules(page)).toEqual([]);
  }
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

const openingFrames = async (page) => {
  await expect.poll(async () => Boolean((await probe(page, "opening")).positioned)).toBe(true);
  return probe(page, "opening");
};

const placeOpening = (frame) => {
  const inside = frame.cards
    .filter(({ left, right }) => left >= frame.fade - 0.5 && right <= frame.width - frame.fade + 0.5)
    .sort((a, b) => a.left - b.left);
  const first = inside[0] || null;
  const previous = first
    ? frame.cards.filter(({ right }) => right <= first.left + 0.5).sort((a, b) => b.right - a.right)[0] || null
    : null;
  return {
    width: frame.width,
    clear: frame.clear,
    fade: frame.fade,
    offset: frame.scrollLeft - frame.groupWidth,
    visible: inside.map(({ id }) => id),
    first,
    previous,
  };
};

const cardLayout = (region) =>
  region.evaluate((el) => {
    const cards = [...el.querySelectorAll(".ri-review-card")];
    const range = document.createRange();
    const spilled = [];
    const clipped = [];
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || node.parentElement.closest(".sr-only")) continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width < 1 || rect.height < 1) continue;
          const px = Math.max(box.left - rect.left, rect.right - box.right, box.top - rect.top, rect.bottom - box.bottom);
          if (px > 1) spilled.push({ id: card.dataset.reviewId, text: node.textContent.trim().slice(0, 40), px: Math.round(px) });
        }
      }
      for (const node of card.querySelectorAll("*")) {
        if (node.closest(".sr-only") || node.getBoundingClientRect().width <= 1) continue;
        const rect = node.getBoundingClientRect();
        const px = Math.max(box.left - rect.left, rect.right - box.right, box.top - rect.top, rect.bottom - box.bottom);
        if (px > 1) spilled.push({ id: card.dataset.reviewId, text: node.tagName, px: Math.round(px) });
        const style = getComputedStyle(node);
        if (style.textOverflow === "ellipsis" ||
          (style.overflow !== "visible" && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1))) {
          clipped.push({ id: card.dataset.reviewId, tag: node.tagName });
        }
      }
    }
    const first = el.firstElementChild.children[1]?.firstElementChild || cards[0];
    return {
      heights: [...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height)))],
      spilled: spilled.filter((entry, index) => spilled.findIndex((other) => other.id === entry.id && other.text === entry.text) === index),
      clipped,
      firstId: first.dataset.reviewId,
      quoteSize: getComputedStyle(first.querySelector("blockquote p")).fontSize,
      firstCopyText: [...el.querySelectorAll('[data-group-index="0"]')].map((card) => card.textContent),
    };
  });

const waitForAutoplay = async (page, region) => {
  const scrollLeft = () => region.evaluate((el) => el.scrollLeft);
  await expect
    .poll(async () => {
      const start = await scrollLeft();
      await page.waitForTimeout(300);
      return Math.abs((await scrollLeft()) - start);
    }, { timeout: 15000 })
    .toBeGreaterThan(1);
  await page.waitForTimeout(1000);
};

const expectOpeningHold = async (page, width, name) => {
  const region = await openCarousel(page, { width, height: 900 });
  const { positioned } = await openingFrames(page);
  const start = placeOpening(positioned);
  const held = await probe(page, "record", 2000);
  const heldPoints = unwrap(held.samples, held.groupWidth);
  const drift = Math.max(...heldPoints.map((point) => Math.abs(point.u - heldPoints[0].u)));
  const settled = await region.evaluate((el) => {
    const view = el.getBoundingClientRect();
    const card = el.firstElementChild.children[1].firstElementChild.getBoundingClientRect();
    return { left: card.left - view.left, right: card.right - view.left };
  });
  await waitForAutoplay(page, region);
  const moving = await probe(page, "record", 1500);
  const speed = speedOf(unwrap(moving.samples, moving.groupWidth));
  const result = {
    width,
    fade: start.fade,
    firstAtStart: start.first,
    firstAfterHold: { left: round(settled.left), right: round(settled.right) },
    heldMs: round(heldPoints[heldPoints.length - 1].t - heldPoints[0].t),
    driftDuringHoldPx: round(drift),
    speedAfterHoldPxPerSecond: round(speed),
  };
  writeEvidence(name, result);
  expect(start.first).not.toBeNull();
  expect(result.heldMs).toBeGreaterThanOrEqual(1900);
  expect(result.driftDuringHoldPx).toBeLessThanOrEqual(0.5);
  expect(Math.abs(settled.left - start.first.left)).toBeLessThanOrEqual(0.5);
  expect(settled.left).toBeGreaterThanOrEqual(start.fade - 0.5);
  expect(speed).toBeGreaterThanOrEqual(CRUISE * 0.7);
  expect(speed).toBeLessThanOrEqual(CRUISE * 1.3);
};

const NARROW_WIDTHS = [320, 360, 390];
const OPENING_CASES = [
  ...[...NARROW_WIDTHS, 1024, 1440].map((width) => ({ width, containerQueries: true, suffix: "" })),
  ...NARROW_WIDTHS.map((width) => ({ width, containerQueries: false, suffix: "-without-container-queries" })),
];

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

const runInfinite = async (page, region, direction, name) => {
  const result = await wheelAcross(page, region, direction, 5);
  writeEvidence(name, result);
  expectInfinite(result);
  return result;
};

test.describe("review carousel", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default four-review fixture.");

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
      await waitForAutoplay(page, region);
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
    await waitForAutoplay(page, region);
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
    await expect(page.getByRole("button", { name: /^(Pause|Play) reviews$/ })).toBeHidden();
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
      const cards = [...el.querySelectorAll(".ri-review-card")];
      const card = cards.find((node) => node.getBoundingClientRect().right > viewport.left + 40);
      const box = card.getBoundingClientRect();
      return { left: box.left - viewport.left, right: viewport.right - box.right };
    });
    expect(Math.abs(firstCard.left - firstCard.right)).toBeLessThanOrEqual(2);
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

  for (const width of [640, 800, 1024, 1440]) {
    test(`arrows-never-cover-review-text-${width}`, async ({ page }) => {
      const region = await openCarousel(page, { width, height: 900 });
      const left = page.getByRole("button", { name: "Scroll reviews left" });
      const right = page.getByRole("button", { name: "Scroll reviews right" });
      await expect(left).toBeVisible();
      await expect(right).toBeVisible();
      const inspect = (state) => region.evaluate((el, state) => {
        const view = el.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('button[aria-label^="Scroll reviews"], button[aria-label$=" reviews"]')].map((button) => ({
          label: button.getAttribute("aria-label"),
          rect: button.getBoundingClientRect(),
        }));
        const covered = [];
        const range = document.createRange();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let lines = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim()) continue;
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            const leftEdge = Math.max(rect.left, view.left);
            const rightEdge = Math.min(rect.right, view.right);
            if (rightEdge - leftEdge < 1 || rect.height < 1) continue;
            lines += 1;
            const text = node.textContent.trim().slice(0, 32);
            for (const { label, rect: box } of buttons) {
              if (leftEdge < box.right && rightEdge > box.left && rect.top < box.bottom && rect.bottom > box.top) {
                covered.push({ state, by: label, text });
              }
            }
            for (const x of [leftEdge + 0.5, (leftEdge + rightEdge) / 2, rightEdge - 0.5]) {
              const hit = document.elementFromPoint(x, (rect.top + rect.bottom) / 2);
              if (hit && !el.contains(hit)) covered.push({ state, by: hit.getAttribute("aria-label") || hit.tagName, text });
            }
          }
        }
        const overlap = buttons.map(({ label, rect }) => ({
          label,
          px: Math.max(0, Math.min(rect.right, view.right) - Math.max(rect.left, view.left)),
        }));
        return { state, lines, covered, overlap, focused: document.activeElement?.getAttribute("aria-label") || null };
      }, state);
      const states = [];
      const record = async (state) => {
        const result = await inspect(state);
        states.push(result);
        writeEvidence(`arrows-never-cover-review-text-${width}`, states);
        expect(result.lines, state).toBeGreaterThan(0);
        expect(result.covered, state).toEqual([]);
        expect(result.overlap.map(({ px }) => px), state).toEqual([0, 0, 0]);
      };
      await record("rest");
      await page.keyboard.press("Shift");
      await region.focus();
      await expect.poll(() => region.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
      await record("region-focus");
      const { groupWidth, pitch } = await probe(page, "state");
      for (let step = 1; step <= 8; step += 1) {
        await region.evaluate((el, value) => { el.scrollLeft = value; }, groupWidth + (pitch * step) / 8);
        await record(`region-focus-scrolled-${step}`);
      }
      await page.keyboard.press("Shift+Tab");
      await expect(left).toBeFocused();
      await record("left-arrow-focus");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(right).toBeFocused();
      await record("right-arrow-focus");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      await record("after-arrow-press");
      await page.evaluate(() => document.documentElement.classList.add("perf-reduced-effects-mode"));
      await record("reduced-effects");
    });
  }

  for (const { width, containerQueries, suffix } of OPENING_CASES) {
    test(`cards-fit-and-line-up-${width}${suffix}`, async ({ page }) => {
      const region = await openCarousel(page, { width, height: 900 }, { containerQueries });
      const { painted, positioned } = await openingFrames(page);
      const layout = await cardLayout(region);
      const start = placeOpening(positioned);
      const firstPaint = placeOpening(painted);
      writeEvidence(`cards-fit-and-line-up-${width}${suffix}`, { ...layout, start, firstPaint });
      expect(layout.heights).toHaveLength(1);
      expect(layout.spilled).toEqual([]);
      expect(layout.clipped).toEqual([]);
      expect(layout.quoteSize).toBe("15px");
      expect(start.first?.id).toBe(layout.firstId);
      expect(firstPaint.first?.id).toBe(layout.firstId);
      expect(Math.abs(firstPaint.first.left - start.first.left)).toBeLessThanOrEqual(1);
      const cardWidth = start.first.right - start.first.left;
      if (width < 640) {
        expect(Math.abs(start.first.left - (start.width - start.first.right))).toBeLessThanOrEqual(2);
        expect(cardWidth).toBeCloseTo(Math.min(320, start.width - 2 * start.fade), 1);
      } else {
        expect(cardWidth).toBeCloseTo(410, 1);
        expect(start.previous.right).toBeLessThanOrEqual(start.clear + 0.5);
      }
    });
  }

  for (const width of [640, 1024, 1440]) {
    test(`opening-holds-first-card-${width}`, async ({ page }) => {
      await expectOpeningHold(page, width, `opening-holds-first-card-${width}`);
    });
  }

  test("pause-button-stops-autoplay-until-played", async ({ page }) => {
    await page.addInitScript(() => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.__rafCount = 0;
      window.requestAnimationFrame = (callback) => {
        window.__rafCount += 1;
        return requestFrame(callback);
      };
    });
    const region = await openCarousel(page);
    await waitForAutoplay(page, region);
    const pause = page.getByRole("button", { name: "Pause reviews" });
    const play = page.getByRole("button", { name: "Play reviews" });
    const travel = async (ms) => {
      const recording = await probe(page, "record", ms);
      const points = unwrap(recording.samples, recording.groupWidth);
      return round(points[points.length - 1].u - points[0].u);
    };
    const rafCount = () => page.evaluate(() => window.__rafCount);

    await expect(pause).toBeVisible();
    const box = await pause.boundingBox();
    const regionBox = await region.boundingBox();
    await pause.click();
    await page.mouse.move(regionBox.x + regionBox.width / 2, regionBox.y + regionBox.height / 2);
    await page.mouse.move(10, 10);
    await expect(play).toBeVisible();
    await page.waitForTimeout(200);
    const framesBefore = await rafCount();
    await page.waitForTimeout(1000);
    const idleFrames = (await rafCount()) - framesBefore;
    const pausedByMouse = await travel(3500);

    await page.mouse.move(regionBox.x + regionBox.width / 2, regionBox.y + regionBox.height / 2);
    await page.mouse.wheel(120, 0);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(400);
    const pausedAfterWheel = await travel(3000);
    await expect(play).toBeVisible();

    await play.focus();
    await page.keyboard.press("Enter");
    await expect(pause).toBeFocused();
    await page.waitForTimeout(2600);
    const resumedByKeyboard = await travel(1500);

    await page.keyboard.press("Space");
    await expect(play).toBeFocused();
    await page.waitForTimeout(300);
    const pausedByKeyboard = await travel(3000);

    await play.click();
    await page.mouse.move(10, 10);
    await page.waitForTimeout(2600);
    const resumedByMouse = await travel(1500);

    const result = {
      button: { width: round(box.width), height: round(box.height), left: round(box.x - regionBox.x), bottom: round(regionBox.y + regionBox.height - (box.y + box.height)) },
      idleFramesWhilePaused: idleFrames,
      pausedByMousePx: pausedByMouse,
      pausedAfterWheelPx: pausedAfterWheel,
      resumedByKeyboardPx: resumedByKeyboard,
      pausedByKeyboardPx: pausedByKeyboard,
      resumedByMousePx: resumedByMouse,
    };
    writeEvidence("pause-button-stops-autoplay-until-played", result);
    expect(result.button.width).toBeGreaterThanOrEqual(24);
    expect(result.button.height).toBeGreaterThanOrEqual(24);
    expect(idleFrames).toBeLessThanOrEqual(2);
    expect(Math.abs(pausedByMouse)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(pausedAfterWheel)).toBeLessThanOrEqual(0.5);
    expect(resumedByKeyboard).toBeGreaterThanOrEqual(CRUISE * 1.5 * 0.7);
    expect(Math.abs(pausedByKeyboard)).toBeLessThanOrEqual(0.5);
    expect(resumedByMouse).toBeGreaterThanOrEqual(CRUISE * 1.5 * 0.7);
  });

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

const controlButtons = 'button[aria-label^="Scroll reviews"], button[aria-label$=" reviews"]';
const visibleControls = (page) =>
  page.locator(controlButtons).evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility({ visibilityProperty: true })).length);
const frameState = (region) =>
  region.evaluate((el) => ({
    scrollLeft: el.scrollLeft,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollbarPx: el.offsetHeight - el.clientHeight,
    frameHeight: el.closest("section").getBoundingClientRect().height,
  }));
const dragScrollbar = async (page, region, start) => {
  const box = await region.boundingBox();
  const thumb = (start.clientWidth * start.clientWidth) / start.scrollWidth;
  const y = box.y + box.height - start.scrollbarPx / 2;
  const x = box.x + Math.max(thumb / 2, 40);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 200, y, { steps: 10 });
  await page.mouse.up();
  return (await frameState(region)).scrollLeft;
};
const swipe = async (page, region) => {
  const box = await region.boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step += 1) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - step * 20, y }] });
    await page.waitForTimeout(16);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await session.detach();
  await page.waitForTimeout(500);
  return (await frameState(region)).scrollLeft;
};
const expectFallbackNavigation = async (page, region, name) => {
  await region.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  const start = await frameState(region);
  const controls = await visibleControls(page);
  expect(start.scrollWidth).toBeGreaterThan(start.clientWidth);
  expect(controls).toBe(0);
  expect(start.scrollbarPx).toBeGreaterThan(0);
  const rewind = () => region.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await rewind();
  const dragged = await dragScrollbar(page, region, start);
  await rewind();
  const swiped = await swipe(page, region);
  await rewind();
  await region.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await frameState(region)).scrollLeft).toBeGreaterThan(0);
  const keyed = (await frameState(region)).scrollLeft;
  const result = { visibleControls: controls, start, draggedScrollLeft: dragged, swipedScrollLeft: swiped, keyedScrollLeft: keyed };
  writeEvidence(name, result);
  expect(dragged).toBeGreaterThan(100);
  expect(swiped).toBeGreaterThan(100);
  expect(keyed).toBeGreaterThan(0);
  return result;
};

test.describe("review carousel when its script fails", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default four-review fixture.");

  for (const width of [390, 1024, 1440]) {
    test(`script-failure-keeps-scrolling-${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const blocked = [];
      await page.route(/\/_next\/static\/chunks\//, (route) => {
        blocked.push(route.request().url());
        return route.abort();
      });
      await page.goto("/", { waitUntil: "load" });
      const region = page.getByRole("region", { name: "Player reviews" });
      const failed = await expectFallbackNavigation(page, region, `script-failure-keeps-scrolling-${width}`);
      expect(blocked.length).toBeGreaterThan(0);
      await region.screenshot({ path: path.join(EVIDENCE_DIR, `script-failure-${width}.png`) });

      await page.unroute(/\/_next\/static\/chunks\//);
      await openCarousel(page, { width, height: 900 });
      const working = await frameState(region);
      const controls = await visibleControls(page);
      writeEvidence(`script-failure-keeps-scrolling-${width}-then-loaded`, { failed, working, controls });
      expect(working.scrollbarPx).toBe(0);
      expect(controls).toBe(width < 640 ? 0 : 3);
      expect(Math.abs(working.frameHeight - failed.start.frameHeight)).toBeLessThanOrEqual(1);
    });
  }
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

  for (const width of [640, 1024, 1440]) {
    test(`two-reviews-opening-holds-first-card-${width}`, async ({ page }) => {
      await expectOpeningHold(page, width, `two-reviews-opening-holds-first-card-${width}`);
    });
  }
});

const control = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const waitForHome = async (request, text) => {
  await expect
    .poll(async () => {
      const response = await request.get("/");
      return response.status() === 200 && (await response.text()).includes(text);
    }, { timeout: 85000, intervals: [1000, 3000] })
    .toBe(true);
};

test.describe("review carousel order", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default four-review fixture.");

  const ordered = ["Vulture", "SkinzOW", "Hydro", "Creator other", "Player first", "Player last"];
  const cms = [
    { name: "Player first" },
    { name: "Hydro", isVip: true },
    { name: "Creator other", isVip: true },
    { name: "Vulture", isVip: true },
    { name: "Player last" },
    { name: "SkinzOW", isVip: true },
  ].map((review) => ({
    ...review,
    text: "The session helped me compare my PC's performance.",
    game: "Overwatch 2",
    rating: 5,
    optimizationResult: "Average FPS: 200 to 240",
  }));

  test.beforeAll(async ({ request, baseURL }) => {
    test.setTimeout(120000);
    await control(request, baseURL, { patch: { _id: "tooling-proReviewsCarousel", reviews: cms } });
    await waitForHome(request, "Creator other");
  });

  test.afterAll(async ({ request, baseURL }) => {
    test.setTimeout(120000);
    await control(request, baseURL, { reset: true });
    await waitForHome(request, "Reviewer 3");
  });

  test("server-html-leads-with-named-creators", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const firstCopy = [...html.matchAll(/data-review-id="([^"]+)"[^>]*data-group-index="0"/g)].map((match) => match[1]);
    writeEvidence("order-server-html", { firstCopy });
    expect(firstCopy).toEqual(ordered);
  });

  for (const { width, containerQueries, suffix } of OPENING_CASES) {
    test(`starts-on-vulture-${width}${suffix}`, async ({ page }) => {
      const region = await openCarousel(page, { width, height: 900 }, { containerQueries });
      const { painted, positioned } = await openingFrames(page);
      const order = await region.evaluate((el) =>
        [...el.querySelectorAll('[data-group-index="1"]')].map((card) => card.dataset.reviewId)
      );
      const start = placeOpening(positioned);
      const firstPaint = placeOpening(painted);
      writeEvidence(`order-start-${width}${suffix}`, { order, start, firstPaint });
      expect(order).toEqual(ordered);
      expect(start.visible).toEqual(ordered.slice(0, start.visible.length));
      expect(start.visible.length).toBeGreaterThanOrEqual(width < 640 ? 1 : width < 1280 ? 2 : 3);
      expect(firstPaint.visible).toEqual(start.visible);
    });
  }
});

test.describe("review carousel with long words", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default four-review fixture.");

  const long = {
    name: "xXNoScopeLegendOfTheEternalStreamXx",
    profession: "twitch.tv/TheLongestUnbrokenStreamerChannelNameEverWritten",
    game: "CounterStrikeGlobalOffensiveLegacyEdition",
    label: "OnePercentLowsAtCompetitiveSettings",
    before: "1,000,000,000,000",
    after: "2,000,000,000,000",
    link: "rooindustries.com/reviews/averyveryverylongpathwithoutanybreaksatallthatkeepsgoing",
  };
  const review = (name, extra = {}) => ({
    name,
    profession: "Top 500 Support Main",
    text: "The session helped me compare my PC's performance.",
    game: "Overwatch 2",
    rating: 5,
    optimizationResult: "Average FPS: 200 → 240",
    ...extra,
  });
  const longFields = () => ({
    profession: long.profession,
    game: long.game,
    optimizationResult: `${long.label}: ${long.before} → ${long.after}`,
    text: `Night and day. Full write-up at ${long.link} if you want the details.`,
  });
  const cms = [
    review("Vulture", { isVip: true }),
    review(long.name, { isVip: true, ...longFields() }),
    review("Player short"),
    review(`${long.name}Player`, longFields()),
  ];

  test.beforeAll(async ({ request, baseURL }) => {
    test.setTimeout(120000);
    await control(request, baseURL, { patch: { _id: "tooling-proReviewsCarousel", reviews: cms } });
    await waitForHome(request, long.profession);
  });

  test.afterAll(async ({ request, baseURL }) => {
    test.setTimeout(120000);
    await control(request, baseURL, { reset: true });
    await waitForHome(request, "Reviewer 3");
  });

  for (const { width, containerQueries, suffix } of [...OPENING_CASES, { width: 640, containerQueries: true, suffix: "" }]) {
    test(`long-words-wrap-inside-cards-${width}${suffix}`, async ({ page }) => {
      const region = await openCarousel(page, { width, height: 900 }, { containerQueries });
      const layout = await cardLayout(region);
      const sizes = await region.evaluate((el) => {
        const card = el.querySelector('[data-group-index="0"] footer');
        const [name, profession] = card.querySelectorAll("p");
        return { name: getComputedStyle(name).fontSize, profession: getComputedStyle(profession).fontSize };
      });
      const shown = layout.firstCopyText.map((text) => text.replace(/\s+/g, " "));
      writeEvidence(`long-words-wrap-inside-cards-${width}${suffix}`, { ...layout, sizes });
      expect(layout.spilled).toEqual([]);
      expect(layout.clipped).toEqual([]);
      expect(layout.heights).toHaveLength(1);
      expect(layout.quoteSize).toBe("15px");
      expect(sizes).toEqual({ name: "15px", profession: "13px" });
      for (const name of [long.name, `${long.name}Player`]) {
        const text = shown.find((entry) => entry.includes(name));
        for (const value of [long.profession, long.game, long.label, long.before, long.after, long.link]) {
          expect(text, `${name} shows ${value}`).toContain(value);
        }
      }
    });
  }
});

test.describe("review carousel FPS results", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default four-review fixture.");

  const results = [
    { name: "Boosted", value: "FPS Boosted", styled: false },
    { name: "Ascii arrow", value: "Avg FPS: 200 -> 360", styled: true, label: "Avg FPS:", arrow: "->" },
    { name: "Bare numbers", value: "200 to 240", styled: true, label: null, arrow: "to" },
    { name: "Lows", value: "1% Lows: 220 → 375", styled: true, label: "1% Lows:", arrow: "→" },
    { name: "With note", value: "Average FPS: 144 → 240 in ranked", styled: true, label: "Average FPS:", arrow: "→" },
    { name: "Sentence", value: "Smoother frametimes and zero stutter spikes after the tune", styled: false },
  ];
  const cms = results.map(({ name, value }, index) => ({
    name,
    isVip: index % 2 === 0,
    profession: "Top 500 Support Main",
    text: "The session helped me compare my PC's performance.",
    game: "Overwatch 2",
    rating: 5,
    optimizationResult: value,
  }));

  test.beforeAll(async ({ request, baseURL }) => {
    test.setTimeout(120000);
    await control(request, baseURL, { patch: { _id: "tooling-proReviewsCarousel", reviews: cms } });
    await waitForHome(request, "Smoother frametimes");
  });

  test.afterAll(async ({ request, baseURL }) => {
    test.setTimeout(120000);
    await control(request, baseURL, { reset: true });
    await waitForHome(request, "Reviewer 3");
  });

  for (const width of [390, 1024, 1440]) {
    test(`fps-results-show-cms-text-${width}`, async ({ page }) => {
      const region = await openCarousel(page, { width, height: 900 });
      const layout = await cardLayout(region);
      const shown = await region.evaluate((el) =>
        [...el.querySelectorAll('[data-group-index="0"]')].map((card) => {
          const result = card.querySelector(".ri-review-result");
          const after = result?.querySelector(".ri-review-champagne-text.text-\\[28px\\]");
          return {
            id: card.dataset.reviewId,
            text: result ? result.textContent : null,
            label: result?.querySelector(".ri-review-result-label")?.textContent ?? null,
            arrow: result?.querySelector(".ri-review-result-arrow")?.textContent ?? null,
            afterSize: after ? getComputedStyle(after).fontSize : null,
          };
        })
      );
      writeEvidence(`fps-results-show-cms-text-${width}`, { shown, spilled: layout.spilled, clipped: layout.clipped, heights: layout.heights });
      await region.screenshot({ path: path.join(EVIDENCE_DIR, `fps-results-${width}.png`) });
      const squash = (text) => String(text).replace(/\s+/g, "");
      for (const expected of results) {
        const card = shown.find((entry) => entry.id === expected.name);
        expect(card, expected.name).toBeTruthy();
        expect(squash(card.text), expected.name).toBe(squash(expected.value));
        expect(card.afterSize, expected.name).toBe(expected.styled ? "28px" : null);
        if (expected.styled) {
          expect(card.label, expected.name).toBe(expected.label);
          expect(card.arrow, expected.name).toBe(expected.arrow);
        }
      }
      expect(layout.spilled).toEqual([]);
      expect(layout.clipped).toEqual([]);
      expect(layout.heights).toHaveLength(1);
    });
  }
});

test.describe("review carousel without JavaScript", () => {
  test.skip(REVIEW_COUNT === 2, "Runs against the default four-review fixture.");
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
    expect(result.htmlFirstCopyCards).toBe(4);
    expect(result.htmlReviewIds).toEqual(["Reviewer 0", "Reviewer 1", "Reviewer 2", "Reviewer 3"]);
    expect(result.renderedFirstCopyCards).toBe(4);
    expect(result.firstCardVisible).toBe(true);
  });

  for (const width of [390, 640, 1024, 1440]) {
    test(`no-js-mouse-and-keyboard-navigation-${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/", { waitUntil: "load" });
      const region = page.getByRole("region", { name: "Player reviews" });
      await expectFallbackNavigation(page, region, `no-js-mouse-and-keyboard-navigation-${width}`);
    });
  }
});

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});
