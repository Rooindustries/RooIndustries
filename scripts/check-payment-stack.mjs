import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config({ path: ".env.local" });

const execFileAsync = promisify(execFile);
const DEFAULT_PREVIEW_URL = String(
  process.env.PREVIEW_SHARE_URL || process.env.BASE_URL || ""
).trim();
const PRODUCTION_URL = "https://www.rooindustries.com";
const REQUIRED_PROD_ENV = [
  "PAYPAL_WEBHOOK_ID",
  "RAZORPAY_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
];

const run = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CI: "true",
      },
    });
    return {
      ok: true,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || "").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || error.message || "").trim(),
    };
  }
};

const fetchJson = async (url, { method = "GET", body = null } = {}) => {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : null,
  });
  let parsed = null;
  let text = "";
  try {
    parsed = await response.clone().json();
  } catch {
    text = (await response.text()).trim();
  }
  return {
    status: response.status,
    ok: response.ok,
    body: parsed || text,
  };
};

const fetchPreviewProvidersWithBrowser = async (previewUrl) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    return await page.evaluate(async () => {
      const response = await fetch("/api/payment/providers", {
        credentials: "include",
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      return {
        status: response.status,
        ok: response.ok,
        body,
      };
    });
  } finally {
    await browser.close();
  }
};

const main = async () => {
  const report = {
    generatedAt: new Date().toISOString(),
    previewUrl: DEFAULT_PREVIEW_URL || null,
    productionUrl: PRODUCTION_URL,
    previewProviders: null,
    productionProviders: null,
    productionEnv: null,
    webhookProbes: {},
    webhookSecurityTest: null,
  };

  if (!DEFAULT_PREVIEW_URL) {
    throw new Error(
      "PREVIEW_SHARE_URL or BASE_URL is required for the preview provider check."
    );
  }

  report.previewProviders = await fetchPreviewProvidersWithBrowser(DEFAULT_PREVIEW_URL);
  report.productionProviders = await fetchJson(
    new URL("/api/payment/providers", PRODUCTION_URL).toString()
  );

  const envResult = await run("vercel", ["env", "ls", "production"]);
  report.productionEnv = {
    ok: envResult.ok,
    present: REQUIRED_PROD_ENV.filter((name) => envResult.stdout.includes(name)),
    missing: REQUIRED_PROD_ENV.filter((name) => !envResult.stdout.includes(name)),
    stderr: envResult.ok ? "" : envResult.stderr,
  };

  report.webhookProbes.paypal = await fetchJson(
    `${PRODUCTION_URL}/api/payment/webhook/paypal`,
    { method: "POST", body: {} }
  );
  report.webhookProbes.razorpay = await fetchJson(
    `${PRODUCTION_URL}/api/payment/webhook/razorpay`,
    { method: "POST", body: {} }
  );

  const securityTest = await run("npm", [
    "test",
    "--",
    "--watch=false",
    "--runInBand",
    "src/__tests__/paymentWebhookSecurity.test.js",
  ]);
  report.webhookSecurityTest = {
    ok: securityTest.ok,
    stderr: securityTest.stderr,
  };

  const previewOk =
    report.previewProviders.ok &&
    report.previewProviders.body?.ok === true &&
    report.previewProviders.body?.providers?.paypal?.enabled === true &&
    report.previewProviders.body?.providers?.razorpay?.enabled === true;
  const productionOk =
    report.productionProviders.ok &&
    report.productionProviders.body?.ok === true &&
    report.productionProviders.body?.providers?.paypal?.enabled === true &&
    report.productionProviders.body?.providers?.razorpay?.enabled === true;
  const envOk =
    report.productionEnv.ok === true &&
    report.productionEnv.missing.length === 0;
  const webhookGuardsOk =
    Number(report.webhookProbes.paypal.status || 0) === 401 &&
    Number(report.webhookProbes.razorpay.status || 0) === 401;
  const testsOk = report.webhookSecurityTest.ok === true;

  console.log(`${JSON.stringify(report, null, 2)}\n`);

  if (!previewOk || !productionOk || !envOk || !webhookGuardsOk || !testsOk) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(`[check-payment-stack] ${error.message}`);
  process.exit(1);
});
