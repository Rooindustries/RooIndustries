import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { createClient } from "@sanity/client";

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
const BOOKING_EMAIL = String(
  process.env.FREE_BOOKING_EMAIL || "serviroo@rooindustries.com"
).trim();
const PACKAGE_TITLE = String(
  process.env.FREE_BOOKING_PACKAGE_TITLE || "Performance Vertex Overhaul"
).trim();
const RUN_ID = String(
  process.env.FREE_BOOKING_RUN_ID || `free-booking-${Date.now()}`
).trim();
const BOOKING_DISCORD = String(
  process.env.FREE_BOOKING_DISCORD ||
    `codex-${RUN_ID.replace(/[^a-z0-9]/gi, "").slice(-10) || "smoke"}`
).trim();
const REQUESTED_COUPON_CODE = String(
  process.env.FREE_BOOKING_COUPON_CODE || ""
).trim();
const CREATE_TEMP_COUPON = String(
  process.env.FREE_BOOKING_CREATE_TEMP_COUPON ??
    (REQUESTED_COUPON_CODE ? "0" : "1")
)
  .trim()
  .toLowerCase() !== "0";
const KEEP_BOOKING_ARTIFACTS = String(
  process.env.FREE_BOOKING_KEEP_ARTIFACTS || "0"
)
  .trim()
  .toLowerCase() === "1";
const BROWSER_MODE = String(process.env.PLAYWRIGHT_BROWSER_MODE || "cdp")
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
const TERMINAL_EMAIL_DISPATCH_STATUSES = new Set([
  "sent",
  "partial",
  "failed",
  "delivery_disabled",
]);

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
  throw new Error("A Sanity write token is required for the booking smoke test.");
}

const created = {
  bookings: [],
  holds: [],
  coupons: [],
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trackCreated = (type, id) => {
  const normalized = String(id || "").trim();
  if (!normalized) return;
  if (!created[type].includes(normalized)) {
    created[type].push(normalized);
  }
};

const buildAppUrl = (pathname) => {
  const url = new URL(pathname, BASE_ORIGIN);
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

const readJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

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

      if (payload.id !== requestId) {
        return;
      }

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
      `[cdp-free-booking-email-check] Failed to import CDP cookies: ${
        error?.message || error
      }`
    );
    return [];
  }
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

const createTemporaryCoupon = async () => {
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  const code = `FREE${suffix}`;
  const doc = await sanityClient.create({
    _type: "coupon",
    title: `Free Booking Smoke ${RUN_ID}`,
    code,
    discountPercent: 100,
    isActive: true,
    canCombineWithReferral: false,
    maxUses: 1,
    timesUsed: 0,
  });

  trackCreated("coupons", doc?._id);

  return {
    code,
    doc,
    temporary: true,
  };
};

const resolveCoupon = async () => {
  if (CREATE_TEMP_COUPON) {
    return createTemporaryCoupon();
  }

  const code = REQUESTED_COUPON_CODE;
  if (!code) {
    throw new Error(
      "FREE_BOOKING_COUPON_CODE is required when FREE_BOOKING_CREATE_TEMP_COUPON=0."
    );
  }

  const coupon = await sanityClient.fetch(
    `*[_type == "coupon" && lower(code) == $code][0]{
      _id,
      code,
      isActive,
      discountPercent,
      maxUses,
      timesUsed
    }`,
    { code: code.toLowerCase() }
  );

  if (!coupon?._id || coupon.discountPercent !== 100 || coupon.isActive === false) {
    throw new Error(`Coupon "${code}" is not a usable 100% active coupon.`);
  }

  return {
    code: coupon.code,
    doc: coupon,
    temporary: false,
  };
};

const resolveTargetSlot = async () => {
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
  const dateSlots = Array.isArray(settings?.dateSlots) ? settings.dateSlots : [];

  for (const entry of dateSlots) {
    const rawDate = String(entry?.date || "").trim();
    if (!rawDate) continue;

    const dateParts = rawDate.split("-").map((value) => Number(value));
    if (
      dateParts.length !== 3 ||
      dateParts.some((value) => !Number.isFinite(value))
    ) {
      continue;
    }

    const [year, month, day] = dateParts;
    const ownerMidnight = new Date(year, month - 1, day);
    ownerMidnight.setHours(0, 0, 0, 0);
    if (ownerMidnight < minDate) continue;

    const hours = (Array.isArray(entry?.times) ? entry.times : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    for (const hour of preferredHours) {
      if (!hours.includes(hour)) continue;
      const utcDate = toUtcFromOwnerLocal(year, month - 1, day, hour);
      const startTimeUTC = utcDate.toISOString();
      if (taken.has(startTimeUTC)) continue;

      return {
        date: rawDate,
        dayOfMonth: day,
        hostHour: hour,
        startTimeUTC,
        displayDate: formatDateForBrowser(utcDate),
        displayTime: formatTimeForBrowser(utcDate),
      };
    }
  }

  throw new Error("No free booking slot found at least 7 days in the future.");
};

const waitForNewPage = async (context, knownPages) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const next = context.pages().find((page) => !knownPages.has(page));
    if (next) return next;
    await delay(100);
  }
  throw new Error("Failed to observe the new background target.");
};

const installPageInstrumentation = async (page) => {
  await page.addInitScript((nextRunId) => {
    window.__codexRunId = nextRunId;
    window.__codexFetchLog = [];
    window.__codexPageErrors = [];
    const originalFetch = window.fetch.bind(window);

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

    window.fetch = async (...args) => {
      const [input, init] = args;
      const response = await originalFetch(...args);
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input || "");
      const method =
        String(
          init?.method ||
            (input instanceof Request ? input.method : "GET") ||
            "GET"
        ).toUpperCase();

      let bodyText = "";
      try {
        bodyText = await response.clone().text();
      } catch {}

      window.__codexFetchLog.push({
        url: requestUrl,
        method,
        status: response.status,
        bodyText,
        at: new Date().toISOString(),
      });

      return response;
    };
  }, RUN_ID);
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

  const versionResponse = await fetch(`${CDP_ENDPOINT}/json/version`);
  if (!versionResponse.ok) {
    throw new Error(`CDP endpoint unavailable at ${CDP_ENDPOINT}.`);
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

const clickDayButton = async (page, dayOfMonth) => {
  const locator = page.getByRole("button", {
    name: new RegExp(`^${dayOfMonth}$`),
  });

  if ((await locator.count()) > 0) {
    await locator.first().click();
    return;
  }

  await page.evaluate((day) => {
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      const firstSpan = candidate.querySelector("span");
      return firstSpan?.textContent?.trim() === String(day);
    });
    if (!button) {
      throw new Error(`Day button ${day} not found.`);
    }
    button.click();
  }, dayOfMonth);
};

const clickTimeButton = async (page, timeLabel) => {
  const locator = page.getByRole("button", { name: timeLabel });

  if ((await locator.count()) > 0) {
    await locator.first().click();
    return;
  }

  await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!button) {
      throw new Error(`Time button "${label}" not found.`);
    }
    button.click();
  }, timeLabel);
};

const captureScreenshot = async (context, page, filePath) => {
  const cdp = await context.newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(filePath, Buffer.from(data, "base64"));
};

const waitForFetchLog = async (
  page,
  { urlIncludes = "", method = "", status = 0, timeout = 60000 } = {}
) => {
  const startedAt = Date.now();
  let matched = null;

  while (Date.now() - startedAt < timeout) {
    matched = await page.evaluate(
      ({ nextUrlIncludes, nextMethod, nextStatus }) => {
        const entries = Array.isArray(window.__codexFetchLog)
          ? window.__codexFetchLog
          : [];
        return (
          entries.find((entry) => {
            const matchesUrl =
              !nextUrlIncludes ||
              String(entry?.url || "").includes(nextUrlIncludes);
            const matchesMethod =
              !nextMethod ||
              String(entry?.method || "").toUpperCase() === nextMethod;
            const matchesStatus =
              !nextStatus || Number(entry?.status || 0) === nextStatus;
            return matchesUrl && matchesMethod && matchesStatus;
          }) || null
        );
      },
      {
        nextUrlIncludes: urlIncludes,
        nextMethod: String(method || "").toUpperCase(),
        nextStatus: Number(status || 0),
      }
    );

    if (matched) {
      break;
    }

    await delay(200);
  }

  if (!matched) {
    throw new Error(
      `Timed out waiting for fetch log entry (${method} ${urlIncludes} ${status}).`
    );
  }

  let body = null;
  try {
    body = matched.bodyText ? JSON.parse(matched.bodyText) : null;
  } catch {
    body = matched.bodyText || null;
  }

  return {
    ...matched,
    body,
  };
};

const getPageErrors = async (page) =>
  page.evaluate(() =>
    Array.isArray(window.__codexPageErrors) ? window.__codexPageErrors : []
  );

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

const getBookingById = async (bookingId) =>
  sanityClient.fetch(
    `*[_type == "booking" && _id == $id][0]{
      _id,
      _createdAt,
      orderId,
      email,
      payerEmail,
      packageTitle,
      packagePrice,
      couponCode,
      message,
      specs,
      paymentProvider,
      paymentVerificationState,
      paymentVerificationWarning,
      startTimeUTC,
      displayDate,
      displayTime,
      emailDispatchDeferred,
      emailDispatchStatus,
      emailDispatchQueuedAt,
      emailDispatchLastAttemptAt,
      emailDispatchLastError,
      emailDispatchClientSentAt,
      emailDispatchOwnerSentAt
    }`,
    { id: bookingId }
  );

const waitForBookingDispatchState = async (bookingId, timeout = 90000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const booking = await getBookingById(bookingId);
    if (
      booking?._id &&
      TERMINAL_EMAIL_DISPATCH_STATUSES.has(
        String(booking.emailDispatchStatus || "").trim().toLowerCase()
      )
    ) {
      return booking;
    }

    await delay(2000);
  }

  throw new Error(
    `Timed out waiting for booking ${bookingId} to reach a terminal email dispatch state.`
  );
};

const fetchCouponArtifacts = async (couponCode) =>
  sanityClient.fetch(
    `*[_type == "coupon" && lower(code) == $code][0]{
      _id,
      code,
      isActive,
      timesUsed,
      maxUses,
      discountPercent
    }`,
    { code: String(couponCode || "").toLowerCase() }
  );

const runBookingFlow = async ({ page, packageDoc, slot, couponCode }) => {
  const bookingUrl = buildAppUrl(
    `/booking?title=${encodeURIComponent(
      packageDoc.title
    )}&price=${encodeURIComponent(packageDoc.price)}&tag=${encodeURIComponent(
      packageDoc.tag || ""
    )}`
  );

  await page.goto(bookingUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.getByText("Select a Date and Time for Your Session").waitFor({
    timeout: 60000,
  });
  const bookingDialog = page.getByRole("dialog");

  await clickDayButton(page, slot.dayOfMonth);
  await clickTimeButton(page, slot.displayTime);
  await bookingDialog.getByRole("button", { name: "Next" }).click();
  const holdResponse = await waitForFetchLog(page, {
    urlIncludes: "/api/holdSlot",
    method: "POST",
    status: 200,
  });
  trackCreated("holds", holdResponse?.body?.holdId);

  await bookingDialog
    .getByPlaceholder("Discord (e.g. Servi#1234 or @Servi)")
    .fill(BOOKING_DISCORD);
  await bookingDialog.getByPlaceholder("Email").fill(BOOKING_EMAIL);
  await bookingDialog
    .getByPlaceholder("PC Specs")
    .fill(`Codex free-booking smoke ${RUN_ID}`);
  await bookingDialog
    .getByPlaceholder("Main use case (Game/Apps)")
    .fill("Booking email smoke test");
  await bookingDialog
    .getByPlaceholder("Any extra requirements?")
    .fill(`Automated booking smoke ${RUN_ID}`);

  await bookingDialog.getByRole("button", { name: "Submit & Pay" }).click();
  await page.waitForURL(/\/payment/, { timeout: 60000 });

  await page.getByRole("heading", { name: /complete payment/i }).waitFor({
    timeout: 60000,
  });
  await page
    .getByRole("dialog")
    .getByText(packageDoc.title, { exact: true })
    .first()
    .waitFor({ timeout: 30000 });

  const providerReadiness = await fetchProviderReadiness(page);
  const paymentPageErrorsBeforeCoupon = await getPageErrors(page);

  const couponInput = page.getByPlaceholder("e.g. BF10");
  await couponInput.fill(couponCode);
  await couponInput
    .locator("xpath=ancestor::div[1]")
    .getByRole("button", { name: "Apply" })
    .click();
  await page.getByText(/Coupon applied: 100% off/i).waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Confirm Free Booking" }).waitFor({
    timeout: 30000,
  });

  await page.getByRole("button", { name: "Confirm Free Booking" }).click();
  const createBookingResponse = await waitForFetchLog(page, {
    urlIncludes: "/api/ref/createBooking",
    method: "POST",
    status: 200,
  });

  const bookingId = String(createBookingResponse?.body?.bookingId || "").trim();
  const emailDispatchToken = String(
    createBookingResponse?.body?.emailDispatchToken || ""
  ).trim();
  const emailDispatch = createBookingResponse?.body?.emailDispatch || null;

  if (!bookingId || !emailDispatchToken || !emailDispatch) {
    throw new Error(
      "createBooking did not return bookingId, emailDispatch, and emailDispatchToken."
    );
  }
  trackCreated("bookings", bookingId);

  await Promise.race([
    page.waitForURL(/\/thank/, { timeout: 60000 }),
    page
      .getByText(/booking has been confirmed|you'll receive a confirmation/i)
      .waitFor({ timeout: 60000 }),
  ]);

  const sendBookingEmailsResponse = await waitForFetchLog(page, {
    urlIncludes: "/api/ref/sendBookingEmails",
    method: "POST",
    status: 200,
    timeout: 60000,
  });

  const thankYouState = {
    url: page.url(),
    headingVisible:
      (await page.getByRole("heading", { name: "Thank You!" }).count()) >= 1,
    confirmationVisible:
      (await page.getByText(/your booking has been confirmed/i).count()) >= 1,
  };

  return {
    holdResponse,
    providerReadiness,
    paymentPageErrorsBeforeCoupon,
    createBookingResponse,
    sendBookingEmailsResponse,
    thankYouState,
  };
};

const cleanupArtifacts = async () => {
  const summary = {
    deleted: [],
    failed: [],
  };

  const deleteIds = [
    ...created.bookings,
    ...created.holds,
    ...created.coupons,
  ];

  for (const id of deleteIds) {
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

const writeArtifacts = async ({ report, screenshotPath, runId }) => {
  const outDir = path.join(process.cwd(), "audit", "payment-email-smoke");
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `free-booking-email-check-${runId}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    outDir,
    reportPath,
    screenshotPath,
  };
};

const main = async () => {
  const packageDoc = await resolvePackageDoc();
  const coupon = await resolveCoupon();
  const slot = await resolveTargetSlot();
  const outDir = path.join(process.cwd(), "audit", "payment-email-smoke");
  await fs.mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, `free-booking-email-check-${RUN_ID}.png`);

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
    const flowResult = await runBookingFlow({
      page,
      packageDoc,
      slot,
      couponCode: coupon.code,
    });
    await captureScreenshot(context, page, screenshotPath);

    const bookingId = String(
      flowResult.createBookingResponse?.body?.bookingId || ""
    ).trim();
    const terminalBooking = await waitForBookingDispatchState(bookingId);
    const couponArtifacts = await fetchCouponArtifacts(coupon.code);
    const finalPageErrors = await getPageErrors(page);

    if (!terminalBooking?._id) {
      throw new Error("Booking was not persisted in Sanity.");
    }

    if (String(terminalBooking.emailDispatchStatus || "").trim() !== "sent") {
      throw new Error(
        `Booking email dispatch ended in "${terminalBooking.emailDispatchStatus}".`
      );
    }

    if (
      !terminalBooking.emailDispatchClientSentAt ||
      !terminalBooking.emailDispatchOwnerSentAt
    ) {
      throw new Error("Booking email dispatch did not send both client and owner emails.");
    }

    const report = {
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      baseUrl: BASE_ORIGIN,
      previewShareTokenPresent: !!BASE_SHARE_TOKEN,
      browserMode: BROWSER_MODE,
      importedCookieCount,
      ownerEmail: BOOKING_EMAIL,
      clientEmail: BOOKING_EMAIL,
      couponCode: coupon.code,
      temporaryCoupon: coupon.temporary,
      package: packageDoc,
      slot,
      holdResponse: flowResult.holdResponse,
      providerReadiness: flowResult.providerReadiness,
      paymentPageErrorsBeforeCoupon: flowResult.paymentPageErrorsBeforeCoupon,
      createBookingResponse: flowResult.createBookingResponse,
      sendBookingEmailsResponse: flowResult.sendBookingEmailsResponse,
      thankYouState: flowResult.thankYouState,
      booking: terminalBooking,
      coupon: couponArtifacts,
      finalPageErrors,
      createdIds: created,
    };

    if (!KEEP_BOOKING_ARTIFACTS) {
      cleanupSummary = await cleanupArtifacts();
      report.cleanup = cleanupSummary;
    }

    const outputs = await writeArtifacts({
      report,
      screenshotPath,
      runId: RUN_ID,
    });

    console.log(
      JSON.stringify(
        {
          ...outputs,
          runId: RUN_ID,
          bookingId,
          couponCode: coupon.code,
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
  console.error(`[cdp-free-booking-email-check] ${error.message}`);
  process.exit(1);
});
