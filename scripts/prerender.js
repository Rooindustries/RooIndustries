const path = require("path");
const Prerenderer = require("@prerenderer/prerenderer");
const JSDOMRenderer = require("@prerenderer/renderer-jsdom");

const routes = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
];

const staticDir = path.join(__dirname, "..", "build");

const prerenderer = new Prerenderer({
  staticDir,
  routes,
  renderer: new JSDOMRenderer({
    renderAfterDocumentEvent: "prerender-ready",
    timeout: 30000,
    maxConcurrentRoutes: 2,
    JSDOMOptions: {
      resources: "usable",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        window.__PRERENDER__ = true;
        window.__PRERENDER_READY__ = false;
        if (!window.fetch && typeof fetch === "function") {
          window.fetch = fetch;
        }
        if (!window.requestAnimationFrame) {
          window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
        }
        setTimeout(() => {
          if (window.__PRERENDER_READY__) return;
          window.__PRERENDER_READY__ = true;
          window.document.dispatchEvent(new Event("prerender-ready"));
        }, 8000);
      },
    },
  }),
});

const run = async () => {
  try {
    await prerenderer.initialize();
    await prerenderer.renderRoutes(routes);
  } finally {
    await prerenderer.destroy();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
