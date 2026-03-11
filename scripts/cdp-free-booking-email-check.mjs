import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { createClient } from "@sanity/client";

dotenv.config({ path: ".env.local" });

const OWNER_TZ = "Asia/Kolkata";
const OWNER_OFFSET_MINUTES = 330;
const BASE_URL = String(process.env.BASE_URL || "https://www.rooindustries.com").trim();
const BOOKING_EMAIL = String(
  process.env.FREE_BOOKING_EMAIL || "serviroo@rooindustries.com"
).trim();
const COUPON_CODE = String(process.env.FREE_BOOKING_COUPON_CODE || "").trim();
const PACKAGE_TITLE = String(
  process.env.FREE_BOOKING_PACKAGE_TITLE || "Performance Vertex Overhaul"
).trim();
const BOOKING_DISCORD = String(
  process.env.FREE_BOOKING_DISCORD || "serviroo"
).trim();
const CDP_ENDPOINT = "http://localhost:9222";
const BROWSER_MODE = String(process.env.PLAYWRIGHT_BROWSER_MODE || "cdp")
  .trim()
  .toLowerCase();

if (!COUPON_CODE) {
  throw new Error("FREE_BOOKING_COUPON_CODE is required.");
}

const sanityClient = createClient({
  projectId:
    process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
  dataset:
    process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || "production",
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    if (dateParts.length !== 3 || dateParts.some((value) => !Number.isFinite(value))) {
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

const installFetchLogger = async (page) => {
  await page.addInitScript(() => {
    window.__codexFetchLog = [];
    const originalFetch = window.fetch.bind(window);

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
  });
};

const openBackgroundPage = async () => {
  if (BROWSER_MODE === "launch") {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await installFetchLogger(page);

    return {
      browser,
      context,
      browserSession: null,
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
  await installFetchLogger(page);

  return {
    browser,
    context,
    browserSession,
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

const runBookingFlow = async ({ page, packageDoc, slot }) => {
  const bookingUrl = `${BASE_URL}/booking?title=${encodeURIComponent(
    packageDoc.title
  )}&price=${encodeURIComponent(packageDoc.price)}&tag=${encodeURIComponent(
    packageDoc.tag || ""
  )}`;

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
  const holdResponse = await waitForFetchLog(
    page,
    {
      urlIncludes: "/api/holdSlot",
      method: "POST",
      status: 200,
    }
  );

  await bookingDialog
    .getByPlaceholder("Discord (e.g. Servi#1234 or @Servi)")
    .fill(BOOKING_DISCORD);
  await bookingDialog.getByPlaceholder("Email").fill(BOOKING_EMAIL);
  await bookingDialog
    .getByPlaceholder("PC Specs")
    .fill("Codex CDP free-booking email test");
  await bookingDialog
    .getByPlaceholder("Main use case (Game/Apps)")
    .fill("Booking email smoke test");
  await bookingDialog
    .getByPlaceholder("Any extra requirements?")
    .fill(`Free booking email smoke using coupon ${COUPON_CODE}`);

  await bookingDialog.getByRole("button", { name: "Submit & Pay" }).click();
  await page.waitForURL(/\/payment/, { timeout: 60000 });

  const couponInput = page.getByPlaceholder("e.g. BF10");
  await couponInput.fill(COUPON_CODE);
  await couponInput.locator("xpath=ancestor::div[1]").getByRole("button", {
    name: "Apply",
  }).click();
  await page.getByText(/Coupon applied: 100% off/i).waitFor({ timeout: 30000 });

  await page.getByRole("button", { name: "Confirm Free Booking" }).click();
  const bookingResponse = await waitForFetchLog(
    page,
    {
      urlIncludes: "/api/ref/createBooking",
      method: "POST",
      status: 200,
    }
  );
  await Promise.race([
    page.waitForURL(/\/thank/, { timeout: 60000 }),
    page
      .getByText(/booking has been confirmed|you'll receive a confirmation/i)
      .waitFor({ timeout: 60000 }),
  ]);
  const thankYouState = {
    url: page.url(),
    headingVisible:
      (await page.getByRole("heading", { name: "Thank You!" }).count()) >= 1,
    confirmationVisible:
      (await page.getByText(/your booking has been confirmed/i).count()) >= 1,
  };

  return {
    holdResponse,
    createBookingResponse: bookingResponse,
    thankYouState,
  };
};

const fetchBookingArtifacts = async (slot) => {
  const booking = await sanityClient.fetch(
    `*[_type == "booking" && email == $email && startTimeUTC == $startTimeUTC][0] | order(_createdAt desc){
      _id,
      _createdAt,
      email,
      packageTitle,
      packagePrice,
      startTimeUTC,
      couponCode,
      paymentProvider,
      paymentVerificationState,
      paymentVerificationWarning
    }`,
    {
      email: BOOKING_EMAIL,
      startTimeUTC: slot.startTimeUTC,
    }
  );
  const coupon = await sanityClient.fetch(
    `*[_type == "coupon" && lower(code) == $code][0]{
      _id,
      code,
      isActive,
      timesUsed,
      maxUses
    }`,
    {
      code: COUPON_CODE.toLowerCase(),
    }
  );

  return { booking, coupon };
};

const writeArtifacts = async (report, screenshotPath) => {
  const outDir = path.join(process.cwd(), "audit", "payment-email-smoke");
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "free-booking-email-check.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    outDir,
    reportPath,
    screenshotPath,
  };
};

const main = async () => {
  const packageDoc = await resolvePackageDoc();
  const slot = await resolveTargetSlot();
  const outDir = path.join(process.cwd(), "audit", "payment-email-smoke");
  await fs.mkdir(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(outDir, `free-booking-email-check-${timestamp}.png`);

  const { browser, context, browserSession, targetId, page } =
    await openBackgroundPage();

  try {
    const flowResult = await runBookingFlow({
      page,
      packageDoc,
      slot,
    });
    await captureScreenshot(context, page, screenshotPath);
    const sanityArtifacts = await fetchBookingArtifacts(slot);
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      ownerEmail: BOOKING_EMAIL,
      clientEmail: BOOKING_EMAIL,
      couponCode: COUPON_CODE,
      package: packageDoc,
      slot,
      holdResponse: flowResult.holdResponse,
      createBookingResponse: flowResult.createBookingResponse,
      thankYouState: flowResult.thankYouState,
      ...sanityArtifacts,
    };

    const outputs = await writeArtifacts(report, screenshotPath);
    console.log(JSON.stringify(outputs, null, 2));
    if (!flowResult.createBookingResponse?.body?.emailDispatch) {
      console.warn(
        "Booking completed but the createBooking response did not include emailDispatch."
      );
    }
  } finally {
    try {
      if (browserSession && targetId) {
        await browserSession.send("Target.closeTarget", { targetId });
      }
    } catch {}
    await browser.close();
  }
};

main().catch((error) => {
  console.error(`[cdp-free-booking-email-check] ${error.message}`);
  process.exit(1);
});
