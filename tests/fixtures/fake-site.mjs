import http from "node:http";

export const packages = [
  { name: "Vertex Essentials", price: "$29.95" },
  { name: "Performance Vertex Max", price: "$99.95" },
];

const page = (body, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const REFERRAL_SCRIPT = `const code = new URLSearchParams(location.search).get("ref"); if (code) sessionStorage.setItem("referral_session", code);`;
const packagesPage = ({ cards = packages, offers = packages, storeReferral = true, postOnLoad = false, externalReferral = false } = {}) => page(
  cards.map(card => `<article class="ri-package-card"><h3>${card.name}</h3><span class="ri-price-current">${card.price}</span></article>`).join(""),
  [
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{
        "@type": "OfferCatalog",
        itemListElement: offers.map(offer => ({ "@type": "Offer", price: offer.price.slice(1), priceCurrency: "USD", itemOffered: { "@type": "Service", name: offer.name } })),
      }],
    })}</script>`,
    storeReferral && externalReferral ? `<script src="/referral.js"></script>` : "",
    storeReferral && !externalReferral ? `<script>${REFERRAL_SCRIPT}</script>` : "",
    postOnLoad ? `<script>fetch("/api/holdSlot", { method: "POST", body: "{}" }).catch(() => {});</script>` : "",
  ].join(""),
);

export const startSite = (overrides = {}) => {
  const requests = [];
  const failures = new Map(Object.entries(overrides.failFirst || {}));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://site");
    const entry = { method: req.method, path: url.pathname, at: Date.now() };
    requests.push(entry);
    if (overrides.dropNonBrowser && !/Mozilla/.test(req.headers["user-agent"] || "")) return req.socket.destroy();
    overrides.onRequest?.(url.pathname);
    const pending = failures.get(url.pathname);
    if (pending > 0) {
      failures.set(url.pathname, pending - 1);
      res.writeHead(503);
      return res.end("busy");
    }
    if (overrides.hang?.includes(url.pathname)) return;
    if (overrides.browserRedirects?.[url.pathname] && /Mozilla/.test(req.headers["user-agent"] || "")) {
      res.writeHead(302, { Location: overrides.browserRedirects[url.pathname] });
      return res.end();
    }
    if (overrides.redirectLoop?.includes(url.pathname)) {
      res.writeHead(302, { Location: url.pathname });
      return res.end();
    }
    if (overrides.resetFetchMidBody?.includes(url.pathname) && !/Mozilla/.test(req.headers["user-agent"] || "")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><body><h1>partial");
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (overrides.status?.[url.pathname]) {
      res.writeHead(overrides.status[url.pathname], { "content-type": "text/html" });
      return res.end(page("error"));
    }
    if (url.pathname === "/api/payment/quote") {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => { entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); });
      if (overrides.resetQuote) return req.socket.destroy();
      const quote = overrides.quote || {};
      res.writeHead(quote.status || 200, { "content-type": "application/json" });
      return res.end(JSON.stringify(quote.body || {
        ok: true, quoteFingerprint: "fixture-quote",
        quote: { grossAmount: 29.95, netAmount: 29.95, isFree: false },
        providers: { dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } },
      }));
    }
    if (url.pathname === "/api/bookingAvailability") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(overrides.availability || { ok: true, settings: { dateSlots: [{ date: "2026-11-01", times: ["2", "3"] }] }, bookedSlots: [] }));
    }
    if (overrides.upstream) {
      if (url.pathname === "/api/payment/providers") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, providers: { dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } } }));
      }
      if (req.method !== "GET") { res.writeHead(405); return res.end(); }
      const target = new URL(overrides.upstream);
      target.pathname = url.pathname;
      target.search = url.search;
      const upstream = http.get(target, { headers: { ...req.headers, host: target.host } }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end("Local fixture forwarding failed"); });
      return;
    }
    if (url.pathname === "/referral.js") {
      if (overrides.resetReferralScript) return req.socket.destroy();
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(REFERRAL_SCRIPT);
    }
    if (url.pathname === "/__fixture/client-start.js") {
      const pathname = url.searchParams.get("path");
      const startup = overrides.startup?.[pathname] || {};
      const flow = pathname === "/" ? "home" : pathname.slice(1);
      return setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/javascript" });
        const action = startup.error
          ? 'throw new Error("Fixture client startup failed")'
          : pathname === "/payment"
            ? `const booking = JSON.parse(sessionStorage.getItem("checkout_booking_state") || "null"); if (!booking) return; fetch('/api/payment/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageTitle: booking.packageTitle }) }).then(response => response.json()).then(body => { if (body.ok && body.quoteFingerprint) document.body.dataset.rooFlowReady = 'payment'; });`
          : `document.body.dataset.rooFlowReady = ${JSON.stringify(flow)}`;
        const readyCheck = startup.requiresExternalReady ? "if (!window.fixtureExternalReady) return;" : "";
        res.end(`const initialize = () => { ${readyCheck} ${action}; }; const start = () => setTimeout(initialize, ${Number(startup.initializeDelay || 0)}); if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();`);
      }, startup.delay || 0);
    }
    if (url.pathname === "/packages") {
      if (overrides.cspScriptBlock) res.setHeader("Content-Security-Policy", "script-src 'none'");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(packagesPage(overrides.packages));
    }
    if (["/", "/booking", "/payment"].includes(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const markers = {
        "/": '<header id="top"><h1>PC game performance optimization</h1><a href="/#packages">Book an optimization</a></header>',
        "/booking": "<h1>Select a Date and Time for Your Session</h1>",
        "/payment": "<h3>Booking Summary</h3>",
      };
      const controls = url.pathname === "/booking" ? '<button aria-label="Next month">Next</button>' : url.pathname === "/payment" ? '<label for="payment-coupon-code">Coupon</label><input id="payment-coupon-code">' : "";
      const body = (overrides.bodies?.[url.pathname] ?? `${markers[url.pathname] || `<h1>${url.pathname}</h1>`}<p>Fixture page ${url.pathname} with its usual content.</p>`) + controls;
      const external = overrides.scriptSources?.[url.pathname];
      const scripts = `<script async src="/__fixture/client-start.js?path=${encodeURIComponent(url.pathname)}"></script>` +
        (external ? `<script crossorigin="anonymous" src="${external}"></script>` : "");
      return res.end(page(body, scripts));
    }
    res.writeHead(404);
    return res.end();
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise(done => {
        server.closeAllConnections();
        server.close(done);
      }),
    }));
  });
};
