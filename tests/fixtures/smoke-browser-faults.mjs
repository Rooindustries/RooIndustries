import { chromium } from "@playwright/test";

if (process.env.FIXTURE_SMOKE_FAULT === "body") {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args);
    if (new URL(response.url).pathname === "/booking") {
      response.arrayBuffer = () => { throw new Error("fixture body reader failed", {
        cause: new Error("fixture reader cause"),
      }); };
    }
    return response;
  };
}

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
    if (["handler", "handler-wait"].includes(process.env.FIXTURE_SMOKE_FAULT)) {
      const register = context.route.bind(context);
      context.route = (pattern, handler) => register(pattern, route => handler(new Proxy(route, {
        get(target, key) {
          if (key === "fulfill" && target.request().url().includes("/__fixture/client-start.js")) {
            if (process.env.FIXTURE_SMOKE_FAULT === "handler-wait") return () => new Promise(() => {});
            return () => { throw new Error("fixture response handler failed", {
              cause: new Error("fixture handler cause"),
            }); };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })));
    }
    if (process.env.FIXTURE_SMOKE_FAULT === "navigation") {
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        page.goto = () => new Promise(() => {});
        return page;
      };
    }
    return context;
  };
  return browser;
};
