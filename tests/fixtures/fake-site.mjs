import http from "node:http";

export const packages = [
  { name: "Vertex Essentials", price: "$29.95" },
  { name: "Performance Vertex Max", price: "$99.95" },
];

const page = (body, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const packagesPage = ({ cards = packages, offers = packages, storeReferral = true, postOnLoad = false } = {}) => page(
  cards.map(card => `<article class="ri-package-card"><h3>${card.name}</h3><span class="ri-price-current">${card.price}</span></article>`).join(""),
  [
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{
        "@type": "OfferCatalog",
        itemListElement: offers.map(offer => ({ "@type": "Offer", price: offer.price.slice(1), priceCurrency: "USD", itemOffered: { "@type": "Service", name: offer.name } })),
      }],
    })}</script>`,
    storeReferral ? `<script>const code = new URLSearchParams(location.search).get("ref"); if (code) sessionStorage.setItem("referral_session", code);</script>` : "",
    postOnLoad ? `<script>fetch("/api/holdSlot", { method: "POST", body: "{}" }).catch(() => {});</script>` : "",
  ].join(""),
);

export const startSite = (overrides = {}) => {
  const requests = [];
  const failures = new Map(Object.entries(overrides.failFirst || {}));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://site");
    requests.push({ method: req.method, path: url.pathname });
    if (overrides.dropNonBrowser && !/Mozilla/.test(req.headers["user-agent"] || "")) return req.socket.destroy();
    overrides.onRequest?.(url.pathname);
    const pending = failures.get(url.pathname);
    if (pending > 0) {
      failures.set(url.pathname, pending - 1);
      res.writeHead(503);
      return res.end("busy");
    }
    if (overrides.hang?.includes(url.pathname)) return;
    if (overrides.resetFetchMidBody?.includes(url.pathname) && !/Mozilla/.test(req.headers["user-agent"] || "")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><body><h1>partial");
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (overrides.status?.[url.pathname]) {
      res.writeHead(overrides.status[url.pathname], { "content-type": "text/html" });
      return res.end(page("error"));
    }
    if (url.pathname === "/api/bookingAvailability") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(overrides.availability || { ok: true, settings: { dateSlots: [{ date: "2026-11-01", times: ["2", "3"] }] }, bookedSlots: [] }));
    }
    if (url.pathname === "/packages") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(packagesPage(overrides.packages));
    }
    if (["/", "/booking", "/payment"].includes(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const markers = {
        "/booking": "<h1>Select a Date and Time for Your Session</h1>",
        "/payment": "<h3>Booking Summary</h3>",
      };
      const body = overrides.bodies?.[url.pathname] ?? `${markers[url.pathname] || `<h1>${url.pathname}</h1>`}<p>Fixture page ${url.pathname} with its usual content.</p>`;
      return res.end(page(body));
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
