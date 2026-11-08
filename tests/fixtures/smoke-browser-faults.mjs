import { chromium } from "@playwright/test";

const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  if (process.env.FIXTURE_SMOKE_FAULT === "launch") {
    return launch({ ...options, executablePath: process.execPath, ignoreDefaultArgs: true,
      args: ["-e", "setInterval(() => {}, 1000)"] });
  }
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    if (process.env.FIXTURE_SMOKE_FAULT === "cookie") {
      context.addCookies = () => { throw new Error("fixture cookie setup failed", {
        cause: new Error("fixture cookie cause"),
      }); };
    }
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      if (process.env.FIXTURE_SMOKE_FAULT === "navigation") page.goto = () => new Promise(() => {});
      if (process.env.FIXTURE_SMOKE_FAULT === "body") {
        const goto = page.goto.bind(page);
        page.goto = async (...args) => {
          const response = await goto(...args);
          if (new URL(args[0]).pathname === "/booking") {
            response.body = () => { throw new Error("fixture body reader failed", {
              cause: new Error("fixture reader cause"),
            }); };
          }
          return response;
        };
      }
      if (["handler", "handler-wait", "quote-body"].includes(process.env.FIXTURE_SMOKE_FAULT)) {
        const on = page.on.bind(page);
        page.on = (event, handler) => event !== "requestfinished" ? on(event, handler) : on(event, request => {
          if (process.env.FIXTURE_SMOKE_FAULT === "quote-body" && request.url().includes("/api/payment/quote")) {
            const response = request.response.bind(request);
            request.response = async () => {
              const result = await response();
              result.body = () => { throw new Error("fixture quote reader failed", {
                cause: new Error("fixture quote reader cause"),
              }); };
              return result;
            };
          } else if (request.url().includes("/__fixture/client-start.js") &&
              process.env.FIXTURE_SMOKE_FAULT !== "quote-body") {
            request.response = process.env.FIXTURE_SMOKE_FAULT === "handler-wait"
              ? () => new Promise(() => {})
              : () => { throw new Error("fixture response handler failed", {
                cause: new Error("fixture handler cause"),
              }); };
          }
          return handler(request);
        });
      }
      return page;
    };
    return context;
  };
  return browser;
};
