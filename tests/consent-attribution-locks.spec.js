const {
  test,
  expect,
  cookieBanner: banner,
  declineCookies,
  openCookieSettings,
  productionHostFixtures,
} = require("./fixtures/booking-flow.cjs");
const { inspectChunks } = require("./fixtures/held-routes.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000 });

const decodeCookie = (value) =>
  JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));

const readAttrCookies = async (context) => {
  const cookies = await context.cookies();
  const out = {};
  for (const cookie of cookies) {
    if (cookie.name === "roo_attr" || cookie.name === "roo_attr_last") {
      out[cookie.name] = decodeCookie(cookie.value);
    }
  }
  return out;
};

const journey = (id, capturedAt, extra = {}) => ({
  version: 2,
  journeyId: id,
  firstTouch: { capturedAt, landingPath: "/", ...extra },
  lastTouch: { capturedAt, landingPath: "/", ...extra },
});

const waitForTabPresence = async (page, minTabs) => {
  await expect.poll(async () => page.evaluate(async () => {
    const state = await navigator.locks.query();
    return (state.held || []).filter((lock) => String(lock?.name || "").startsWith("roo_attr_tab:")).length;
  })).toBeGreaterThanOrEqual(minTabs);
};

test("late peer reply during three-tab Accept preserves the newer touch without wiping it", async ({
  page,
  context,
}) => {
  const tabA = page;
  await tabA.addInitScript(() => {
    const OrigBC = window.BroadcastChannel;
    window.__bcSent = [];
    window.BroadcastChannel = class DelayedBC extends OrigBC {
      postMessage(msg) {
        window.__bcSent.push(msg?.type || "");
        if (msg?.type === "session_attribution_reply") {
          setTimeout(() => super.postMessage(msg), 700);
          return;
        }
        return super.postMessage(msg);
      }
    };
  });

  await tabA.goto("/referrals/login");
  await expect(banner(tabA)).toBeVisible();
  const newer = journey("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-11-25T10:05:00.000Z", { source: "newer" });
  await tabA.evaluate((value) => {
    sessionStorage.setItem("sales_attribution", JSON.stringify(value));
  }, newer);

  const tabC = await context.newPage();
  await tabC.goto("/referrals/login");
  await expect(banner(tabC)).toBeVisible();
  const older = journey("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2026-11-25T10:00:00.000Z", { source: "older" });
  await tabC.evaluate((value) => {
    sessionStorage.setItem("sales_attribution", JSON.stringify(value));
  }, older);

  const tabB = await context.newPage();
  await tabB.goto("/referrals/login");
  await expect(banner(tabB)).toBeVisible();
  await waitForTabPresence(tabB, 3);

  await banner(tabB).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(tabB)).toHaveCount(0);

  await expect.poll(async () => {
    const cookies = await readAttrCookies(context);
    const sessionA = await tabA.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null"));
    return {
      firstSource: cookies.roo_attr?.firstTouch?.source || null,
      lastSource: cookies.roo_attr_last?.lastTouch?.source || null,
      sessionASource: sessionA?.lastTouch?.source || null,
    };
  }).toMatchObject({ firstSource: "older" });

  await tabA.waitForTimeout(800);
  const finalState = {
    cookies: await readAttrCookies(context),
    sessionA: await tabA.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")),
    sentA: await tabA.evaluate(() => window.__bcSent || []),
  };
  const newerPreserved =
    finalState.cookies.roo_attr_last?.lastTouch?.source === "newer" ||
    finalState.sessionA?.lastTouch?.source === "newer";
  expect(newerPreserved).toBe(true);
  expect(finalState.sentA).not.toContain("session_attribution_promoted_ack");
});

test("cookie refusal during Accept keeps peer session attribution intact", async ({ page, context }) => {
  await context.addInitScript(() => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set() {
        return "";
      },
    });
  });

  const tabA = page;
  await tabA.goto("/referrals/login");
  await expect(banner(tabA)).toBeVisible();
  const touchA = journey("11111111-1111-4111-8111-111111111111", "2026-11-25T10:00:00.000Z", { source: "peerA" });
  await tabA.evaluate((value) => {
    sessionStorage.setItem("sales_attribution", JSON.stringify(value));
  }, touchA);

  const tabB = await context.newPage();
  await tabB.goto("/referrals/login");
  await expect(banner(tabB)).toBeVisible();
  await waitForTabPresence(tabB, 2);

  await banner(tabB).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(tabB)).toHaveCount(0);
  await tabA.waitForTimeout(400);

  expect(await readAttrCookies(context)).toEqual({});
  const sessionA = await tabA.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null"));
  const sessionB = await tabB.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null"));
  expect(sessionA?.lastTouch?.source).toBe("peerA");
  expect(sessionB?.lastTouch?.source).toBe("peerA");
});

test("Accept holds Level 1 cookie lock through peer acknowledgment and clears peer session", async ({
  page,
  context,
}) => {
  const tabA = page;
  await tabA.addInitScript(() => {
    const OrigBC = window.BroadcastChannel;
    window.__ackHeld = false;
    window.__releaseAck = null;
    window.BroadcastChannel = class GateAckBC extends OrigBC {
      postMessage(msg) {
        if (msg?.type === "session_attribution_promoted_ack") {
          window.__ackHeld = true;
          new Promise((resolve) => {
            window.__releaseAck = resolve;
          }).then(() => super.postMessage(msg));
          return;
        }
        return super.postMessage(msg);
      }
    };
  });

  await tabA.goto("/referrals/login");
  await expect(banner(tabA)).toBeVisible();
  const touchA = journey("22222222-2222-4222-8222-222222222222", "2026-11-25T10:00:00.000Z", { source: "peerFirst" });
  await tabA.evaluate((value) => {
    sessionStorage.setItem("sales_attribution", JSON.stringify(value));
  }, touchA);

  const tabB = await context.newPage();
  await tabB.goto("/referrals/login");
  await expect(banner(tabB)).toBeVisible();
  const touchB = journey("33333333-3333-4333-8333-333333333333", "2026-11-25T10:02:00.000Z", {
    source: "initiatorLast",
  });
  await tabB.evaluate((value) => {
    sessionStorage.setItem("sales_attribution", JSON.stringify(value));
  }, touchB);
  await waitForTabPresence(tabB, 2);

  await banner(tabB).getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => tabA.evaluate(() => window.__ackHeld)).toBe(true);

  const lockHeldBeforeAck = await tabA.evaluate(async () => {
    const state = await navigator.locks.query();
    return (state.held || []).some((lock) => lock.name === "roo_sales_attribution_cookie");
  });
  expect(lockHeldBeforeAck).toBe(true);

  await tabA.evaluate(() => window.__releaseAck?.());
  await expect(banner(tabB)).toHaveCount(0);
  await expect.poll(async () => tabA.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  const cookies = await readAttrCookies(context);
  expect(cookies.roo_attr?.firstTouch?.source).toBe("peerFirst");
  expect(cookies.roo_attr_last?.lastTouch?.source).toBe("initiatorLast");
});

test("denied attribution writes wait on Level 1 cookie lock before writing sessionStorage", async ({
  page,
  context,
}) => {
  await page.goto("/referrals/login");
  await declineCookies(page);
  await expect(banner(page)).toHaveCount(0);

  const holder = await context.newPage();
  await holder.goto("/referrals/login");
  await holder.evaluate(() => {
    window.__level1Held = false;
    window.__releaseLevel1 = null;
    navigator.locks.request(
      "roo_sales_attribution_cookie",
      () =>
        new Promise((resolve) => {
          window.__level1Held = true;
          window.__releaseLevel1 = resolve;
        }),
    );
  });
  await expect.poll(() => holder.evaluate(() => window.__level1Held)).toBe(true);

  const writer = await context.newPage();
  await writer.goto("/packages?utm_source=lockedwrite&utm_campaign=level1");
  await writer.waitForTimeout(400);
  expect(await writer.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

  await holder.evaluate(() => window.__releaseLevel1?.());
  await expect.poll(async () =>
    writer.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.lastTouch?.source || null),
  ).toBe("lockedwrite");
});

test("choice-only roo-consent storage failure publishes no collection broadcast and keeps prior state", async ({
  page,
  context,
}) => {
  const peer = page;
  await peer.goto("/referrals/login");
  await declineCookies(peer);
  await expect(banner(peer)).toHaveCount(0);
  await peer.evaluate(() => {
    window.__seenMessages = [];
    const ch = new BroadcastChannel("roo_sales_attribution_sync");
    ch.addEventListener("message", (event) => {
      window.__seenMessages.push(event.data?.type || "");
    });
    window.__probeChannel = ch;
  });

  const tabB = await context.newPage();
  await tabB.goto("/referrals/login");
  await openCookieSettings(tabB);
  await expect(banner(tabB)).toBeVisible();
  await tabB.evaluate(() => {
    localStorage.setItem("roo-consent", "denied");
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function failingConsent(key, value) {
      if (this === window.localStorage && key === "roo-consent") {
        throw new DOMException("Consent write rejected", "QuotaExceededError");
      }
      return orig.call(this, key, value);
    };
  });
  await waitForTabPresence(tabB, 2);
  const epochBefore = await tabB.evaluate(() => localStorage.getItem("roo-consent-epoch"));

  await banner(tabB).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(tabB)).toHaveCount(0);
  await peer.waitForTimeout(300);

  expect(await peer.evaluate(() => window.__seenMessages)).not.toContain("collect_session_attribution");
  expect(await tabB.evaluate(() => localStorage.getItem("roo-consent"))).toBe("denied");
  expect(await tabB.evaluate(() => localStorage.getItem("roo-consent-epoch"))).toBe(epochBefore);
});

test("Accept promotes legacy v1 session journeys to v2 cookies and strips reserved ad tags", async ({
  page,
  context,
}) => {
  await page.goto("/referrals/login");
  await expect(banner(page)).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.setItem(
      "sales_attribution",
      JSON.stringify({
        version: 1,
        journeyId: "44444444-4444-4444-8444-444444444444",
        capturedAt: "2026-11-20T09:00:00.000Z",
        landingPath: "/packages",
        source: "google",
        creatorCode: "gads-max",
      }),
    );
  });

  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);

  await expect.poll(async () => readAttrCookies(context)).toMatchObject({
    roo_attr: {
      version: 2,
      journeyId: "44444444-4444-4444-8444-444444444444",
      firstTouch: { landingPath: "/packages", source: "google" },
    },
    roo_attr_last: {
      journeyId: "44444444-4444-4444-8444-444444444444",
      lastTouch: { landingPath: "/packages", source: "google" },
    },
  });
  const cookies = await readAttrCookies(context);
  expect(cookies.roo_attr.firstTouch.creatorCode).toBeUndefined();
  expect(cookies.roo_attr_last.lastTouch.creatorCode).toBeUndefined();
});

test("Reset and Decline clear all tracking cookies under full localStorage quota and Accept recovers cleanly", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=quota_src&utm_campaign=quota_camp");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("quota_src");

  await page.evaluate(() => {
    localStorage.removeItem("roo-consent-epoch");
    document.cookie = "_fbp=fb.1.1700000000000.123456; Path=/; Max-Age=3600; SameSite=Lax";
    document.cookie = "_fbc=fb.1.1700000000000.abcdef; Path=/; Max-Age=3600; SameSite=Lax";
    window.__origSetItem = Storage.prototype.setItem;
    window.__origRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function fullQuota(key, value) {
      if (this === window.localStorage) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return window.__origSetItem.call(this, key, value);
    };
  });

  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBeNull();
  const afterResetCookies = (await context.cookies()).map((c) => c.name);
  for (const name of ["roo_attr", "roo_attr_last", "_fbp", "_fbc"]) {
    expect(afterResetCookies).not.toContain(name);
  }
  const sessionAfterReset = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("sales_attribution") || "null"),
  );
  expect(sessionAfterReset?.firstTouch?.source).toBe("quota_src");

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__origSetItem;
    localStorage.setItem("roo-consent", "granted");
    localStorage.removeItem("roo-consent-epoch");
    document.cookie = "_fbp=fb.1.1700000000000.223456; Path=/; Max-Age=3600; SameSite=Lax";
    document.cookie = "_fbc=fb.1.1700000000000.bbcdef; Path=/; Max-Age=3600; SameSite=Lax";
    Storage.prototype.setItem = function blockedSet(key, value) {
      if (this === window.localStorage) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return window.__origSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function blockedRemove(key) {
      if (this === window.localStorage) {
        throw new DOMException("Storage blocked", "SecurityError");
      }
      return window.__origRemoveItem.call(this, key);
    };
  });

  await declineCookies(page);
  await expect(banner(page)).toHaveCount(0);
  const afterDeclineCookies = (await context.cookies()).map((c) => c.name);
  for (const name of ["roo_attr", "roo_attr_last", "_fbp", "_fbc"]) {
    expect(afterDeclineCookies).not.toContain(name);
  }

  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();
  const afterBlockedResetCookies = (await context.cookies()).map((c) => c.name);
  for (const name of ["roo_attr", "roo_attr_last", "_fbp", "_fbc"]) {
    expect(afterBlockedResetCookies).not.toContain(name);
  }

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__origSetItem;
    Storage.prototype.removeItem = window.__origRemoveItem;
  });

  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("quota_src");
  await page.reload();
  await expect(banner(page)).toHaveCount(0);
});

test("Reset waits on Level 1 cookie lock and preserves journey to session before clearing cookies", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=locked_reset&utm_campaign=hold_l1");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("locked_reset");

  const holder = await context.newPage();
  await holder.goto("/referrals/login");
  await holder.evaluate(() => {
    window.__l1Held = false;
    window.__releaseL1 = null;
    navigator.locks.request(
      "roo_sales_attribution_cookie",
      () =>
        new Promise((resolve) => {
          window.__l1Held = true;
          window.__releaseL1 = resolve;
        }),
    );
  });
  await expect.poll(() => holder.evaluate(() => window.__l1Held)).toBe(true);

  const resetter = await context.newPage();
  await resetter.goto("/packages");
  await resetter.getByRole("button", { name: "Cookie settings", exact: true }).click();
  await resetter.waitForTimeout(400);
  expect((await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("locked_reset");

  await holder.evaluate(() => window.__releaseL1?.());
  await expect(banner(resetter)).toBeVisible();
  expect(await readAttrCookies(context)).toEqual({});
  const preserved = await resetter.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null"));
  expect(preserved?.firstTouch?.source).toBe("locked_reset");
});

test("failed epoch write never rolls back committed epoch or lets an old Reset replay", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const OrigBC = window.BroadcastChannel;
    window.__heldReset = null;
    window.__releaseHeldReset = () => {
      if (!window.__heldReset) return;
      const { ch, msg } = window.__heldReset;
      window.__heldReset = null;
      OrigBC.prototype.postMessage.call(ch, msg);
    };
    window.BroadcastChannel = class HoldResetBC extends OrigBC {
      postMessage(msg) {
        if (msg?.type === "sync_declined_attribution" && !window.__heldReset) {
          window.__heldReset = { ch: this, msg: structuredClone(msg) };
          return;
        }
        return super.postMessage(msg);
      }
    };
  });

  await page.goto("/packages?utm_source=stale_reset&utm_campaign=epoch_guard");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("stale_reset");

  const peer = await context.newPage();
  await peer.addInitScript(() => {
    const OrigBC = window.BroadcastChannel;
    window.__peerSent = [];
    window.__peerReceived = [];
    window.BroadcastChannel = class SpyBC extends OrigBC {
      constructor(name) {
        super(name);
        if (name === "roo_sales_attribution_sync") {
          this.addEventListener("message", (event) => {
            if (event?.data?.type === "sync_declined_attribution") {
              window.__peerReceived.push(event.data.consentEpoch);
            }
          });
        }
      }
      postMessage(msg) {
        window.__peerSent.push({ type: msg?.type || "", epoch: msg?.consentEpoch ?? null });
        return super.postMessage(msg);
      }
    };
  });
  await peer.goto("/referrals/login");
  await waitForTabPresence(page, 2);

  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(window.__heldReset))).toBe(true);

  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  const epochAtGrant = await page.evaluate(() => localStorage.getItem("roo-consent-epoch"));
  expect(JSON.parse(epochAtGrant || "{}").nextEpoch).toBe(3);

  await page.evaluate(() => {
    window.__origSetItemEpoch = Storage.prototype.setItem;
    Storage.prototype.setItem = function rejectEpoch(key, value) {
      if (this === window.localStorage && key === "roo-consent-epoch") {
        throw new DOMException("Epoch write blocked", "QuotaExceededError");
      }
      return window.__origSetItemEpoch.call(this, key, value);
    };
  });

  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBe("granted");
  expect(await page.evaluate(() => localStorage.getItem("roo-consent-epoch"))).toBe(epochAtGrant);
  expect(await readAttrCookies(context)).toEqual({});

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__origSetItemEpoch;
  });
  await openCookieSettings(page);
  await expect(banner(peer)).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(localStorage.getItem("roo-consent-epoch") || "{}").nextEpoch),
  ).toBe(4);
  expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBeNull();
  await expect.poll(() =>
    peer.evaluate(() => window.__peerSent.some((entry) => entry.type === "sync_declined_ack" && entry.epoch === 4)),
  ).toBe(true);

  await peer.evaluate(() => {
    sessionStorage.removeItem("sales_attribution");
    window.__peerSent = [];
    window.__peerReceived = [];
  });
  await page.evaluate(() => window.__releaseHeldReset());
  await expect.poll(() => peer.evaluate(() => window.__peerReceived.includes(2))).toBe(true);
  await peer.evaluate(() => navigator.locks.request("roo_consent_state_lock", () => true));

  expect(await peer.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  expect(await peer.evaluate(() => window.__peerSent.map((entry) => entry.type))).not.toContain("sync_declined_ack");
});

test("choice-only Decline write failure keeps shared grant intact and leaves peer banner closed", async ({
  page,
  context,
}) => {
  await page.goto("/referrals/login");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);

  const peer = await context.newPage();
  await peer.goto("/referrals/login");
  await expect(banner(peer)).toHaveCount(0);
  await waitForTabPresence(page, 2);
  const epochBefore = await page.evaluate(() => localStorage.getItem("roo-consent-epoch"));

  await page.evaluate(() => {
    window.__origRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function blockRemove(key) {
      if (this === window.localStorage && key === "roo-consent") {
        throw new DOMException("Remove blocked", "SecurityError");
      }
      return window.__origRemove.call(this, key);
    };
  });
  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();

  await page.evaluate(() => {
    Storage.prototype.removeItem = window.__origRemove;
    const origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function rejectChoice(key, value) {
      if (this === window.localStorage && key === "roo-consent") {
        throw new DOMException("Consent write rejected", "QuotaExceededError");
      }
      return origSet.call(this, key, value);
    };
  });

  await declineCookies(page);
  await expect(banner(page)).toHaveCount(0);
  await peer.waitForTimeout(300);

  expect(await page.evaluate(() => sessionStorage.getItem("roo-consent"))).toBe("denied");
  expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBe("granted");
  expect(await page.evaluate(() => localStorage.getItem("roo-consent-epoch"))).toBe(epochBefore);
  await expect(banner(peer)).toHaveCount(0);
});

test("peer clears contributed journey and acknowledges Accept even while storage event is pending", async ({
  page,
  context,
}) => {
  const peer = page;
  await peer.addInitScript(() => {
    const OrigBC = window.BroadcastChannel;
    window.__peerAcks = [];
    window.BroadcastChannel = class AckSpyBC extends OrigBC {
      postMessage(msg) {
        if (msg?.type === "session_attribution_promoted_ack") {
          window.__peerAcks.push(msg);
        }
        return super.postMessage(msg);
      }
    };
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key === "roo-consent" || event.key === null) {
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  });

  await peer.goto("/referrals/login");
  await expect(banner(peer)).toBeVisible();
  await peer.evaluate(() => {
    sessionStorage.setItem("roo-consent", "denied");
    sessionStorage.setItem(
      "sales_attribution",
      JSON.stringify({
        version: 1,
        journeyId: "55555555-5555-4555-8555-555555555555",
        capturedAt: "2026-11-22T09:00:00.000Z",
        landingPath: "/packages",
        source: "pending_storage",
      }),
    );
  });

  const actor = await context.newPage();
  await actor.goto("/referrals/login");
  await expect(banner(actor)).toBeVisible();
  await waitForTabPresence(actor, 2);

  await banner(actor).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(actor)).toHaveCount(0);

  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("pending_storage");
  await expect.poll(() => peer.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  expect(await peer.evaluate(() => window.__peerAcks.length)).toBe(1);
  expect(await peer.evaluate(() => window.__peerAcks[0]?.consentEpoch)).toBe(1);
});

test("legacy grant Reset under full localStorage quota hands off attribution to open peer tabs", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=legacy_quota_handoff&utm_campaign=two_tab");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe(
    "legacy_quota_handoff",
  );

  await page.evaluate(() => {
    localStorage.removeItem("roo-consent-epoch");
    document.cookie = "_fbp=fb.1.1700000000000.323456; Path=/; Max-Age=3600; SameSite=Lax";
    document.cookie = "_fbc=fb.1.1700000000000.cbcdef; Path=/; Max-Age=3600; SameSite=Lax";
  });

  const peer = await context.newPage();
  await peer.goto("/referrals/login");
  await expect(banner(peer)).toHaveCount(0);
  await waitForTabPresence(page, 2);

  await page.evaluate(() => {
    let low = 0;
    let high = 10 * 1024 * 1024;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      try {
        localStorage.setItem("roo_quota_pad", "x".repeat(mid));
        low = mid;
      } catch {
        high = mid - 1;
      }
    }
    localStorage.setItem("roo_quota_pad", "x".repeat(low));
  });

  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(peer)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBeNull();
  const remainingCookies = (await context.cookies()).map((c) => c.name);
  for (const name of ["roo_attr", "roo_attr_last", "_fbp", "_fbc"]) {
    expect(remainingCookies).not.toContain(name);
  }

  await page.close();
  await peer.evaluate(() => localStorage.removeItem("roo_quota_pad"));
  await peer.goto("/packages");
  const peerSession = await peer.evaluate(() =>
    JSON.parse(sessionStorage.getItem("sales_attribution") || "null"),
  );
  expect(peerSession?.firstTouch?.source).toBe("legacy_quota_handoff");
});

test("queued campaign write under Level 1 contention is visible immediately to same-tab reads", async ({
  page,
  context,
  flow,
}) => {
  await page.goto("/packages?utm_source=first_camp&utm_campaign=initial");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("first_camp");

  const holder = await context.newPage();
  await holder.goto("/referrals/login");
  await holder.evaluate(() => {
    window.__l1Contend = false;
    window.__releaseContend = null;
    navigator.locks.request(
      "roo_sales_attribution_cookie",
      () =>
        new Promise((resolve) => {
          window.__l1Contend = true;
          window.__releaseContend = resolve;
        }),
    );
  });
  await expect.poll(() => holder.evaluate(() => window.__l1Contend)).toBe(true);

  await page.evaluate(() => {
    window.__sameDocContend = 1;
    const state = { ...(window.history.state || {}), __rooLegacy: true };
    window.history.pushState(state, "", "/packages?utm_source=second_camp&utm_campaign=newer");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
  await page.waitForTimeout(200);
  expect((await readAttrCookies(context)).roo_attr_last?.lastTouch?.source).toBe("first_camp");

  await page.locator('a[href^="/booking"]').first().click();
  await page.getByRole("button", { name: /^Earliest available:/ }).click();
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
  await flow.details();
  await page.getByRole("button", { name: "Review before payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
  let releaseStart = null;
  await page.route("**/api/payment/start", async (route) => {
    await new Promise((resolve) => {
      releaseStart = resolve;
    });
    await route.fallback();
  });

  await flow.payment();
  expect(await page.evaluate(() => window.__sameDocContend)).toBe(1);
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect.poll(() => Boolean(releaseStart)).toBe(true);
  await holder.evaluate(() => window.__releaseContend?.());
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr_last?.lastTouch?.source).toBe("second_camp");
  releaseStart();
  await expect(page.getByRole("heading", { name: "Checkout handoff", exact: true })).toBeVisible();
  const [start] = flow.startBodies();
  expect(start.bookingPayload.salesAttribution.firstTouch.source).toBe("first_camp");
  expect(start.bookingPayload.salesAttribution.lastTouch.source).toBe("second_camp");
});

test("SecurityError from Web Locks still falls back for Accept, Reset, and Decline", async ({
  page,
  context,
}) => {
  const rejections = [];
  page.on("pageerror", (err) => rejections.push(err.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: () => Promise.reject(new DOMException("Locks unavailable", "SecurityError")),
        query: () => Promise.reject(new DOMException("Locks unavailable", "SecurityError")),
      },
    });
  });

  await page.goto("/packages?utm_source=lock_sec_err&utm_campaign=fallback");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("lock_sec_err");

  await openCookieSettings(page);
  await expect(banner(page)).toBeVisible();
  expect(await readAttrCookies(context)).toEqual({});
  await declineCookies(page);
  await expect(banner(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("roo-consent"))).toBe("denied");
  expect(rejections).toEqual([]);
});

test("memory-only journey captured when sessionStorage rejects writes is promoted on Accept", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function rejectSession(key, value) {
      if (this === window.sessionStorage && key === "sales_attribution") {
        throw new DOMException("Session storage blocked", "QuotaExceededError");
      }
      return orig.call(this, key, value);
    };
  });

  await page.goto("/packages?utm_source=mem_only&utm_campaign=promote");
  await expect(banner(page)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("mem_only");
});

test("closing the Reset tab before peer handoff lets the surviving peer keep the journey", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=reset_close_seed&utm_campaign=delta");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("reset_close_seed");

  const peer = await context.newPage();
  await peer.goto("/referrals/login");
  await expect(banner(peer)).toHaveCount(0);
  await waitForTabPresence(page, 2);

  await page.evaluate(() => {
    document.cookie = "_fbp=fb.1.1700000000000.423456; Path=/; Max-Age=3600; SameSite=Lax";
    navigator.locks.query = () =>
      new Promise(() => {
        window.__resetDiscoveryEntered = true;
      });
  });

  await openCookieSettings(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.__resetDiscoveryEntered))).toBe(true);
  await expect(banner(peer)).toBeVisible();
  expect((await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe("reset_close_seed");
  expect((await context.cookies()).map((c) => c.name)).not.toContain("_fbp");

  await page.close();
  await peer.evaluate(() => navigator.locks.request("roo_sales_attribution_cookie", () => true));
  const peerSession = await peer.evaluate(() =>
    JSON.parse(sessionStorage.getItem("sales_attribution") || "null"),
  );
  expect(peerSession?.firstTouch?.source).toBe("reset_close_seed");
  expect(await readAttrCookies(context)).toEqual({});
});

test("Decline handoff after peer sessionStorage quota recovery keeps peer's newer touch", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=older_actor&utm_campaign=delta");
  await expect(banner(page)).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.firstTouch?.source || null),
  ).toBe("older_actor");

  const peer = await context.newPage();
  await peer.addInitScript(() => {
    if (sessionStorage.getItem("roo_quota_done")) return;
    let low = 0;
    let high = 10 * 1024 * 1024;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      try {
        sessionStorage.setItem("roo_session_pad", "x".repeat(mid));
        low = mid;
      } catch {
        high = mid - 1;
      }
    }
    sessionStorage.setItem("roo_session_pad", "x".repeat(low));
  });
  await peer.goto("/packages?utm_source=newer_peer&utm_campaign=delta");
  await expect(banner(peer)).toBeVisible();
  expect(await peer.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  await waitForTabPresence(page, 2);

  await peer.evaluate(() => {
    sessionStorage.removeItem("roo_session_pad");
    sessionStorage.setItem("roo_quota_done", "1");
  });
  await declineCookies(page);
  await expect(banner(page)).toHaveCount(0);

  await expect.poll(() =>
    peer.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")),
  ).toMatchObject({
    firstTouch: { source: "older_actor" },
    lastTouch: { source: "newer_peer" },
  });

  await peer.goto("/referrals/login");
  const persisted = await peer.evaluate(() =>
    JSON.parse(sessionStorage.getItem("sales_attribution") || "null"),
  );
  expect(persisted?.firstTouch?.source).toBe("older_actor");
  expect(persisted?.lastTouch?.source).toBe("newer_peer");
});

test("closing the Reset tab before handoff preserves the journey across multiple surviving tabs", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=reset_close_multi&utm_campaign=delta");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe(
    "reset_close_multi",
  );

  const peerOne = await context.newPage();
  await peerOne.goto("/referrals/login");
  const peerTwo = await context.newPage();
  await peerTwo.goto("/referrals/login");
  await waitForTabPresence(page, 3);

  await page.evaluate(() => {
    navigator.locks.query = () =>
      new Promise(() => {
        window.__resetDiscoveryEntered = true;
      });
  });

  await openCookieSettings(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.__resetDiscoveryEntered))).toBe(true);
  await expect(banner(peerOne)).toBeVisible();
  await expect(banner(peerTwo)).toBeVisible();

  await page.close();
  await peerOne.evaluate(() => navigator.locks.request("roo_sales_attribution_cookie", () => true));
  await peerTwo.evaluate(() => navigator.locks.request("roo_sales_attribution_cookie", () => true));
  const sources = await Promise.all(
    [peerOne, peerTwo].map((tab) =>
      tab.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.firstTouch?.source || null),
    ),
  );
  expect(sources).toEqual(["reset_close_multi", "reset_close_multi"]);
  expect(await readAttrCookies(context)).toEqual({});
});

test("closing Reset tab before handoff still saves journey in healthy peer when first survivor is full", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=reset_close_quota&utm_campaign=delta");
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe(
    "reset_close_quota",
  );

  const fullPeer = await context.newPage();
  await fullPeer.goto("/referrals/login");
  const healthyPeer = await context.newPage();
  await healthyPeer.addInitScript(() => {
    const origRequest = navigator.locks.request.bind(navigator.locks);
    window.__gateHealthyLock = false;
    window.__releaseHealthyLock = () => {};
    navigator.locks.request = (name, ...rest) => {
      if (window.__gateHealthyLock && name === "roo_sales_attribution_cookie") {
        window.__gateHealthyLock = false;
        return new Promise((resolve) => {
          window.__releaseHealthyLock = () => resolve(origRequest(name, ...rest));
        });
      }
      return origRequest(name, ...rest);
    };
  });
  await healthyPeer.goto("/referrals/login");
  await waitForTabPresence(page, 3);

  await fullPeer.evaluate(() => {
    let low = 0;
    let high = 10 * 1024 * 1024;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      try {
        sessionStorage.setItem("roo_session_pad", "x".repeat(mid));
        low = mid;
      } catch {
        high = mid - 1;
      }
    }
    sessionStorage.setItem("roo_session_pad", "x".repeat(low));
  });
  await healthyPeer.evaluate(() => {
    window.__gateHealthyLock = true;
  });
  await page.evaluate(() => {
    navigator.locks.query = () =>
      new Promise(() => {
        window.__resetDiscoveryEntered = true;
      });
  });

  await openCookieSettings(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.__resetDiscoveryEntered))).toBe(true);
  await expect(banner(fullPeer)).toBeVisible();
  await expect(banner(healthyPeer)).toBeVisible();

  await page.close();
  await fullPeer.evaluate(() => navigator.locks.request("roo_sales_attribution_cookie", () => true));
  await healthyPeer.evaluate(() => window.__releaseHealthyLock());
  await healthyPeer.evaluate(() => navigator.locks.request("roo_sales_attribution_cookie", () => true));

  expect(
    await healthyPeer.evaluate(
      () => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.firstTouch?.source || null,
    ),
  ).toBe("reset_close_quota");
  expect(await readAttrCookies(context)).toEqual({});

  await fullPeer.evaluate(() => {
    sessionStorage.removeItem("roo_session_pad");
  });
  await fullPeer.goto("/packages");
  expect(
    await healthyPeer.evaluate(
      () => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.firstTouch?.source || null,
    ),
  ).toBe("reset_close_quota");
});

test("Decline handoff skips ack while peer sessionStorage stays full and promotes both touches on Accept", async ({
  page,
  context,
}) => {
  await page.goto("/packages?utm_source=decline_full_actor&utm_campaign=delta");
  await expect(banner(page)).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.firstTouch?.source || null),
  ).toBe("decline_full_actor");

  const peer = await context.newPage();
  await peer.addInitScript(() => {
    const OrigBC = window.BroadcastChannel;
    window.__peerSentAcks = [];
    window.BroadcastChannel = class SpyAckBC extends OrigBC {
      postMessage(msg) {
        if (msg?.type === "sync_declined_ack") {
          window.__peerSentAcks.push(msg.consentEpoch);
        }
        return super.postMessage(msg);
      }
    };
    let low = 0;
    let high = 10 * 1024 * 1024;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      try {
        sessionStorage.setItem("roo_session_pad", "x".repeat(mid));
        low = mid;
      } catch {
        high = mid - 1;
      }
    }
    sessionStorage.setItem("roo_session_pad", "x".repeat(low));
  });
  await peer.goto("/packages?utm_source=decline_full_peer&utm_campaign=delta");
  await expect(banner(peer)).toBeVisible();
  expect(await peer.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();
  await waitForTabPresence(page, 2);

  await declineCookies(page);
  await expect(banner(page)).toHaveCount(0);
  await expect(banner(peer)).toHaveCount(0);
  expect(await peer.evaluate(() => window.__peerSentAcks)).toEqual([]);
  expect(await peer.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

  await peer.evaluate(() => {
    sessionStorage.removeItem("roo_session_pad");
  });
  await openCookieSettings(peer);
  await expect(banner(peer)).toBeVisible();
  await banner(peer).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(peer)).toHaveCount(0);
  await expect.poll(async () => await readAttrCookies(context)).toMatchObject({
    roo_attr: { firstTouch: { source: "decline_full_actor" } },
    roo_attr_last: { lastTouch: { source: "decline_full_peer" } },
  });
});

test("peer unsavedFallback captured under full sessionStorage is collected on Accept in another tab", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    let low = 0;
    let high = 10 * 1024 * 1024;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      try {
        sessionStorage.setItem("roo_session_pad", "x".repeat(mid));
        low = mid;
      } catch {
        high = mid - 1;
      }
    }
    sessionStorage.setItem("roo_session_pad", "x".repeat(low));
  });
  await page.goto("/packages?utm_source=peer_unsaved_collect&utm_campaign=delta");
  await expect(banner(page)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("sales_attribution"))).toBeNull();

  const actor = await context.newPage();
  await actor.goto("/referrals/login");
  await expect(banner(actor)).toBeVisible();
  await waitForTabPresence(actor, 2);

  await banner(actor).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner(actor)).toHaveCount(0);
  await expect.poll(async () => (await readAttrCookies(context)).roo_attr?.firstTouch?.source).toBe(
    "peer_unsaved_collect",
  );
});

const productionTest = test.extend(productionHostFixtures);

productionTest("Intercom chunk 404 never loads on booking and never breaks production pages", async ({
  page,
  productionHost,
}) => {
  let intercomChunkHits = 0;
  await inspectChunks(
    page,
    { origin: productionHost.origin, fetchOrigin: productionHost.loopback },
    () => undefined,
    (route, response, body) => {
      if (body.includes("intercom-embed-script")) {
        intercomChunkHits += 1;
        return route.fulfill({ status: 404, body: "" });
      }
      return route.fulfill({ response, body });
    },
  );

  await page.goto("/booking?package=overhaul");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("We couldn’t load this page.")).toHaveCount(0);
  expect(intercomChunkHits).toBe(0);

  await page.goto("/packages");
  await expect(page.getByRole("heading", { name: /Packages|Performance Vertex Overhaul/i }).first()).toBeVisible();
  await expect.poll(() => intercomChunkHits).toBeGreaterThan(0);
  await expect(page.getByText("We couldn’t load this page.")).toHaveCount(0);
});
