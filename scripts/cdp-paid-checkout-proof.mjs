import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { createClient } from "@sanity/client";
import { verifyPaymentAccessToken } from "../src/server/api/payment/accessToken.js";

dotenv.config({ path: ".env.local" });

const OWNER_TZ = "Asia/Kolkata";
const OWNER_OFFSET_MINUTES = 330;
const DEFAULT_BASE_URL = "https://www.rooindustries.com";
const RAW_BASE_URL = String(
  process.env.PREVIEW_SHARE_URL || process.env.BASE_URL || DEFAULT_BASE_URL
).trim();
const BASE_URL = new URL(RAW_BASE_URL);
const BASE_ORIGIN = `${BASE_URL.protocol}//${BASE_URL.host}`;
const BASE_SHARE_TOKEN = String(
  BASE_URL.searchParams.get("_vercel_share") ||
    process.env.PREVIEW_SHARE_TOKEN ||
    ""
).trim();
const BROWSER_MODE = String(process.env.PLAYWRIGHT_BROWSER_MODE || "launch")
  .trim()
  .toLowerCase();
const CDP_ENDPOINT = String(process.env.CDP_ENDPOINT || "http://localhost:9222")
  .trim()
  .replace(/\/$/, "");
const IMPORT_CDP_COOKIES = String(
  process.env.IMPORT_CDP_COOKIES === undefined
    ? "1"
    : process.env.IMPORT_CDP_COOKIES
)
  .trim()
  .toLowerCase() !== "0";
const PACKAGE_TITLE = String(
  process.env.PAID_BOOKING_PACKAGE_TITLE || "Performance Vertex Overhaul"
).trim();
const BOOKING_EMAIL = String(
  process.env.PAID_BOOKING_EMAIL || "serviroo@rooindustries.com"
).trim();
const RUN_ID = String(
  process.env.PAID_BOOKING_RUN_ID || `paid-proof-${Date.now()}`
).trim();
const BOOKING_DISCORD = String(
  process.env.PAID_BOOKING_DISCORD ||
    `codex-${RUN_ID.replace(/[^a-z0-9]/gi, "").slice(-10) || "proof"}`
).trim();

const sanityClient = createClient({
  projectId:
    process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
  dataset:
    process.env.SANITY_DATASET ||
    process.env.NEXT_PUBLIC_SANITY_DATASET ||
    "production",
  apiVersion:
    process.env.SANITY_API_VERSION ||
    process.env.NEXT_PUBLIC_SANITY_API_VERSION ||
    "2023-10-01",
  token:
    process.env.SANITY_WRITE_TOKEN ||
    process.env.REACT_APP_SANITY_WRITE_TOKEN ||
    process.env.SANITY_API_TOKEN,
  useCdn: false,
});

if (!sanityClient.config().token) {
  throw new Error("A Sanity write token is required for the paid proof cleanup.");
}

const created = {
  holds: [],
  paymentRecords: [],
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trackCreated = (type, id) => {
  const normalized = String(id || "").trim();
  if (!normalized) return;
  if (!created[type].includes(normalized)) {
    created[type].push(normalized);
  }
};

const buildAppUrl = (pathname, searchParams = null) => {
  const url = new URL(pathname, BASE_ORIGIN);
  if (searchParams && typeof searchParams === "object") {
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }
  if (BASE_SHARE_TOKEN && !url.searchParams.has("_vercel_share")) {
    url.searchParams.set("_vercel_share", BASE_SHARE_TOKEN);
  }
  return url.toString();
};

const toUtcFromOwnerLocal = (year, monthIndex, day, hour) =>
  new Date(
    Date.UTC(year, monthIndex, day, hour, 0, 0) -
      OWNER_OFFSET_MINUTES * 60 * 1000
  );

const formatDateForBrowser = (date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);

const formatTimeForBrowser = (date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

const normalizeSameSite = (value) => {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  if (normalized === "lax") return "Lax";
  return undefined;
};

const sendBrowserCdpCommand = async (method, params = {}) => {
  const versionResponse = await fetch(`${CDP_ENDPOINT}/json/version`);
  if (!versionResponse.ok) {
    throw new Error(`CDP endpoint unavailable at ${CDP_ENDPOINT}.`);
  }

  const version = await versionResponse.json();
  const wsUrl = String(version?.webSocketDebuggerUrl || "").trim();
  if (!wsUrl) {
    throw new Error("CDP browser websocket URL is missing.");
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const requestId = 1;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data || ""));
      } catch (error) {
        socket.close();
        reject(error);
        return;
      }

      if (payload.id !== requestId) return;

      socket.close();
      if (payload.error) {
        reject(
          new Error(
            payload.error.message || `${method} failed over the CDP websocket.`
          )
        );
        return;
      }

      resolve(payload.result || {});
    });

    socket.addEventListener("error", (event) => {
      socket.close();
      reject(new Error(event?.message || `${method} websocket error.`));
    });
  });
};

const exportCookiesFromCdp = async () => {
  if (!IMPORT_CDP_COOKIES || BROWSER_MODE !== "launch") {
    return [];
  }

  try {
    const result = await sendBrowserCdpCommand("Storage.getCookies");
    return (Array.isArray(result?.cookies) ? result.cookies : [])
      .map((cookie) => {
        const normalized = {
          name: String(cookie?.name || "").trim(),
          value: String(cookie?.value || ""),
          domain: String(cookie?.domain || "").trim(),
          path: String(cookie?.path || "/"),
          httpOnly: cookie?.httpOnly === true,
          secure: cookie?.secure === true,
        };

        if (!normalized.name || !normalized.domain) {
          return null;
        }

        const expires = Number(cookie?.expires);
        if (Number.isFinite(expires) && expires > 0) {
          normalized.expires = expires;
        }

        const sameSite = normalizeSameSite(cookie?.sameSite);
        if (sameSite) {
          normalized.sameSite = sameSite;
        }

        return normalized;
      })
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `[cdp-paid-checkout-proof] Failed to import CDP cookies: ${
        error?.message || error
      }`
    );
    return [];
  }
};

const installPageInstrumentation = async (page) => {
  await page.addInitScript((nextRunId) => {
    window.__codexRunId = nextRunId;
    window.__codexPageErrors = [];
    window.addEventListener("error", (event) => {
      window.__codexPageErrors.push({
        type: "error",
        message: String(event?.message || ""),
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event?.reason;
      window.__codexPageErrors.push({
        type: "unhandledrejection",
        message:
          typeof reason === "string"
            ? reason
            : String(reason?.message || reason || ""),
      });
    });
  }, RUN_ID);
};

const waitForNewPage = async (context, knownPages) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const next = context.pages().find((page) => !knownPages.has(page));
    if (next) return next;
    await delay(100);
  }
  throw new Error("Failed to observe the new background target.");
};

const openBackgroundPage = async () => {
  if (BROWSER_MODE === "launch") {
    const importedCookies = await exportCookiesFromCdp();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    if (importedCookies.length > 0) {
      await context.addCookies(importedCookies);
    }
    const page = await context.newPage();
    await installPageInstrumentation(page);
    return {
      browser,
      context,
      browserSession: null,
      importedCookieCount: importedCookies.length,
      targetId: "",
      page,
    };
  }

  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No Chromium context available over CDP.");
  }

  const browserSession = await browser.newBrowserCDPSession();
  const knownPages = new Set(context.pages());
  const { targetId } = await browserSession.send("Target.createTarget", {
    url: "about:blank",
    background: true,
  });
  const page = await waitForNewPage(context, knownPages);
  await installPageInstrumentation(page);

  return {
    browser,
    context,
    browserSession,
    importedCookieCount: 0,
    targetId,
    page,
  };
};

const captureScreenshot = async (context, page, filePath) => {
  const cdp = await context.newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(filePath, Buffer.from(data, "base64"));
};

const getPageErrors = async (page) =>
  page.evaluate(() =>
    Array.isArray(window.__codexPageErrors) ? window.__codexPageErrors : []
  );

const waitForCount = async (locator, minimum = 1, timeout = 15000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if ((await locator.count()) >= minimum) {
      return true;
    }
    await delay(250);
  }
  return (await locator.count()) >= minimum;
};

const resolvePackageDoc = async () => {
  const pkg = await sanityClient.fetch(
    `*[_type == "package" && title == $title][0]{ title, price, tag }`,
    { title: PACKAGE_TITLE }
  );

  if (!pkg?.title || !pkg?.price) {
    throw new Error(`Package "${PACKAGE_TITLE}" not found in Sanity.`);
  }

  return pkg;
};

const resolveTargetSlots = async (count = 2) => {
  const minDate = new Date();
  minDate.setHours(0, 0, 0, 0);
  minDate.setDate(minDate.getDate() + 7);

  const [settings, bookings, holds] = await Promise.all([
    sanityClient.fetch(`*[_type == "bookingSettings"][0]{ dateSlots }`),
    sanityClient.fetch(`*[_type == "booking"]{ startTimeUTC }`),
    sanityClient.fetch(`*[_type == "slotHold" && expiresAt > now()]{ startTimeUTC }`),
  ]);

  const preferredHours = [20, 21, 22, 23, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const taken = new Set(
    [...(bookings || []), ...(holds || [])]
      .map((entry) => String(entry?.startTimeUTC || "").trim())
      .filter(Boolean)
  );
  const slots = [];
  const dateSlots = Array.isArray(settings?.dateSlots) ? settings.dateSlots : [];

  for (const entry of dateSlots) {
    const rawDate = String(entry?.date || "").trim();
    if (!rawDate) continue;

    const [year, month, day] = rawDate.split("-").map((value) => Number(value));
    if (![year, month, day].every(Number.isFinite)) continue;

    const ownerMidnight = new Date(year, month - 1, day);
    ownerMidnight.setHours(0, 0, 0, 0);
    if (ownerMidnight < minDate) continue;

    const hours = (Array.isArray(entry?.times) ? entry.times : [])
      .map((value) => Number(value))
      .filter(Number.isFinite);

    for (const hour of preferredHours) {
      if (!hours.includes(hour)) continue;
      const utcDate = toUtcFromOwnerLocal(year, month - 1, day, hour);
      const startTimeUTC = utcDate.toISOString();
      if (taken.has(startTimeUTC)) continue;

      slots.push({
        date: rawDate,
        dayOfMonth: day,
        hostHour: hour,
        startTimeUTC,
        displayDate: formatDateForBrowser(utcDate),
        displayTime: formatTimeForBrowser(utcDate),
      });
      taken.add(startTimeUTC);
      if (slots.length >= count) {
        return slots;
      }
    }
  }

  throw new Error(`Only found ${slots.length} free slots; ${count} are required.`);
};

const reserveHoldFromPage = async (page, { startTimeUTC, packageTitle }) => {
  const result = await page.evaluate(
    async ({ nextStartTimeUTC, nextPackageTitle }) => {
      const response = await fetch("/api/holdSlot", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          startTimeUTC: nextStartTimeUTC,
          packageTitle: nextPackageTitle,
        }),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {}
      return {
        status: response.status,
        body,
      };
    },
    {
      nextStartTimeUTC: startTimeUTC,
      nextPackageTitle: packageTitle,
    }
  );

  if (
    result.status !== 200 ||
    !result?.body?.ok ||
    !result?.body?.holdId ||
    !result?.body?.holdToken
  ) {
    throw new Error(
      result?.body?.error || result?.body?.message || "Failed to reserve a slot."
    );
  }
  trackCreated("holds", result.body.holdId);
  return result.body;
};

const buildBookingPayload = ({ packageDoc, slot, hold }) => ({
  discord: BOOKING_DISCORD,
  email: BOOKING_EMAIL,
  specs: `Codex paid proof ${RUN_ID}`,
  mainGame: "Paid payment proof",
  message: `Automated paid proof ${RUN_ID}`,
  packageTitle: packageDoc.title,
  packagePrice: packageDoc.price,
  paymentProvider: "",
  localTimeZone: OWNER_TZ,
  startTimeUTC: slot.startTimeUTC,
  displayDate: slot.displayDate,
  displayTime: slot.displayTime,
  slotHoldId: hold.holdId,
  slotHoldToken: hold.holdToken,
  slotHoldExpiresAt: hold.expiresAt,
});

const fetchProviderReadiness = async (page) =>
  page.evaluate(async () => {
    const response = await fetch("/api/payment/providers", {
      credentials: "include",
    });
    let body = null;
    try {
      body = await response.json();
    } catch {}
    return {
      status: response.status,
      body,
    };
  });

const startProviderSession = async (page, provider, bookingPayload) =>
  page.evaluate(
    async ({ nextProvider, nextBookingPayload }) => {
      const response = await fetch("/api/payment/start", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: nextProvider,
          bookingPayload: nextBookingPayload,
        }),
      });

      let body = null;
      try {
        body = await response.json();
      } catch {}

      return {
        status: response.status,
        body,
      };
    },
    {
      nextProvider: provider,
      nextBookingPayload: bookingPayload,
    }
  );

const fetchPaymentStatus = async (page, paymentAccessToken) =>
  page.evaluate(
    async (nextPaymentAccessToken) => {
      const response = await fetch(
        `/api/payment/status?paymentAccessToken=${encodeURIComponent(
          nextPaymentAccessToken
        )}`,
        {
          credentials: "include",
        }
      );
      let body = null;
      try {
        body = await response.json();
      } catch {}
      return {
        status: response.status,
        body,
      };
    },
    paymentAccessToken
  );

const cleanupArtifacts = async () => {
  const summary = {
    deleted: [],
    failed: [],
  };

  for (const id of [...created.paymentRecords, ...created.holds]) {
    try {
      await sanityClient.delete(id);
      summary.deleted.push(id);
    } catch (error) {
      summary.failed.push({
        id,
        error: error?.message || String(error),
      });
    }
  }

  return summary;
};

const writeArtifacts = async ({ report, screenshotPath }) => {
  const outDir = path.join(process.cwd(), "audit", "payment-email-smoke");
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `paid-checkout-proof-${RUN_ID}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    outDir,
    reportPath,
    screenshotPath,
  };
};

const main = async () => {
  const packageDoc = await resolvePackageDoc();
  const [paypalSlot, razorpaySlot] = await resolveTargetSlots(2);
  const outDir = path.join(process.cwd(), "audit", "payment-email-smoke");
  await fs.mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, `paid-checkout-proof-${RUN_ID}.png`);

  const {
    browser,
    context,
    browserSession,
    importedCookieCount,
    targetId,
    page,
  } = await openBackgroundPage();

  let cleanupSummary = null;

  try {
    await page.goto(buildAppUrl("/"), {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const paypalHold = await reserveHoldFromPage(page, {
      startTimeUTC: paypalSlot.startTimeUTC,
      packageTitle: packageDoc.title,
    });
    const razorpayHold = await reserveHoldFromPage(page, {
      startTimeUTC: razorpaySlot.startTimeUTC,
      packageTitle: packageDoc.title,
    });
    const paypalPayload = buildBookingPayload({
      packageDoc,
      slot: paypalSlot,
      hold: paypalHold,
    });
    const razorpayPayload = buildBookingPayload({
      packageDoc,
      slot: razorpaySlot,
      hold: razorpayHold,
    });

    await page.goto(
      buildAppUrl("/payment", {
        data: JSON.stringify(paypalPayload),
      }),
      {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }
    );
    await page.getByRole("heading", { name: /complete payment/i }).waitFor({
      timeout: 60000,
    });
    await page
      .getByText(packageDoc.title, { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /pay with razorpay/i }).waitFor({
      timeout: 30000,
    });

    const providerReadiness = await fetchProviderReadiness(page);
    const initialPageErrors = await getPageErrors(page);
    const paypalBlockVisible = await waitForCount(
      page.locator('img[alt="PayPal payment logo"]')
    );
    const razorpayButtonPresent = await waitForCount(
      page.getByRole("button", { name: /pay with razorpay/i })
    );

    if (!providerReadiness?.body?.providers?.paypal?.enabled) {
      throw new Error("PayPal is not enabled on the target preview.");
    }
    if (!providerReadiness?.body?.providers?.razorpay?.enabled) {
      throw new Error("Razorpay is not enabled on the target preview.");
    }
    if (!paypalBlockVisible || !razorpayButtonPresent) {
      throw new Error("The paid payment UI did not render both provider affordances.");
    }

    const paypalStart = await startProviderSession(page, "paypal", paypalPayload);
    const paypalToken = String(paypalStart?.body?.paymentAccessToken || "").trim();
    if (paypalStart.status !== 200 || !paypalStart?.body?.ok || !paypalToken) {
      throw new Error(
        paypalStart?.body?.error || "PayPal session start did not succeed."
      );
    }
    const paypalDecoded = verifyPaymentAccessToken({ token: paypalToken });
    if (!paypalDecoded?.ok) {
      throw new Error(
        `PayPal payment access token was invalid: ${paypalDecoded?.reason || "unknown"}.`
      );
    }
    trackCreated("paymentRecords", paypalDecoded.payload.paymentRecordId);
    const paypalStatus = await fetchPaymentStatus(page, paypalToken);
    if (paypalStatus.status !== 200 || paypalStatus?.body?.status !== "started") {
      throw new Error("PayPal session did not remain in started state.");
    }

    const razorpayStart = await startProviderSession(
      page,
      "razorpay",
      razorpayPayload
    );
    const razorpayToken = String(
      razorpayStart?.body?.paymentAccessToken || ""
    ).trim();
    if (razorpayStart.status !== 200 || !razorpayStart?.body?.ok || !razorpayToken) {
      throw new Error(
        razorpayStart?.body?.error || "Razorpay session start did not succeed."
      );
    }
    const razorpayDecoded = verifyPaymentAccessToken({ token: razorpayToken });
    if (!razorpayDecoded?.ok) {
      throw new Error(
        `Razorpay payment access token was invalid: ${
          razorpayDecoded?.reason || "unknown"
        }.`
      );
    }
    trackCreated("paymentRecords", razorpayDecoded.payload.paymentRecordId);
    const razorpayStatus = await fetchPaymentStatus(page, razorpayToken);
    if (
      razorpayStatus.status !== 200 ||
      razorpayStatus?.body?.status !== "started"
    ) {
      throw new Error("Razorpay session did not remain in started state.");
    }

    const finalPageErrors = await getPageErrors(page);
    await captureScreenshot(context, page, screenshotPath);

    const report = {
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      baseUrl: BASE_ORIGIN,
      previewShareTokenPresent: !!BASE_SHARE_TOKEN,
      browserMode: BROWSER_MODE,
      importedCookieCount,
      package: packageDoc,
      providerReadiness,
      ui: {
        paypalBlockVisible,
        razorpayButtonPresent,
      },
      initialPageErrors,
      paypal: {
        slot: paypalSlot,
        holdId: paypalHold.holdId,
        start: paypalStart,
        status: paypalStatus,
      },
      razorpay: {
        slot: razorpaySlot,
        holdId: razorpayHold.holdId,
        start: razorpayStart,
        status: razorpayStatus,
      },
      finalPageErrors,
      createdIds: created,
    };

    cleanupSummary = await cleanupArtifacts();
    report.cleanup = cleanupSummary;

    const outputs = await writeArtifacts({
      report,
      screenshotPath,
    });

    console.log(
      JSON.stringify(
        {
          ...outputs,
          runId: RUN_ID,
          cleanup: cleanupSummary,
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (browserSession && targetId) {
        await browserSession.send("Target.closeTarget", { targetId });
      }
    } catch {}

    if (BROWSER_MODE === "launch") {
      await browser.close();
    }
  }
};

main().catch((error) => {
  console.error(`[cdp-paid-checkout-proof] ${error.message}`);
  process.exit(1);
});
