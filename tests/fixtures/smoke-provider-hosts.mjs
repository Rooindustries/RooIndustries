import { chromium } from "@playwright/test";
import { isProductionMonitor } from "../../scripts/lib/production-monitor.mjs";

const fixture = new URL(process.env.SMOKE_PROVIDER_FIXTURE);
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    const register = context.route.bind(context);
    context.route = async (pattern, handler) => {
      await register(pattern, handler);
      await register(/https:\/\/[^/]+\.(?:paypal|razorpay|dodopayments)\.com\//, async route => {
        const request = route.request();
        if (request.method() !== "GET" || !isProductionMonitor()) return route.fallback();
        const source = new URL(request.url());
        const target = new URL(source.pathname + source.search, fixture);
        const response = await fetch(target, { headers: { "x-fixture-host": source.hostname } });
        const headers = Object.fromEntries(response.headers);
        delete headers["content-length"];
        delete headers["content-encoding"];
        return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      });
    };
    return context;
  };
  return browser;
};
