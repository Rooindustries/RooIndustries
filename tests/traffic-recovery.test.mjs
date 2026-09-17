import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const base = process.env.BASE_URL;

for (const path of ["/tourney/bracket", "/tourney/roster"]) {
  test(`redirects ${path} to public results`, { skip: !base }, async () => {
    const response = await fetch(new URL(path, base), { redirect: "manual" });
    assert.equal(response.status, 308);
    assert.equal(new URL(response.headers.get("location"), base).pathname, "/tourney");
    const destination = await fetch(new URL(response.headers.get("location"), base));
    assert.equal(destination.status, 200);
    assert.match(await destination.text(), /GetSkii’d/);
  });
}

for (const path of ["/tourney/manage", "/tourney/control", "/tourney/roster/private"]) {
  test(`keeps retired private or unknown route ${path} closed`, { skip: !base }, async () => {
    const response = await fetch(new URL(path, base), { redirect: "manual" });
    assert.equal(response.status, 404);
  });
}

for (const [path, text] of [
  ["/packages", "Performance Vertex Max"],
  ["/faq", "Frequently asked questions"],
  ["/contact", "serviroo@rooindustries.com"],
  ["/BIOSGuide", "BIOS"],
]) {
  test(`serves crawlable content at ${path} without JavaScript`, { skip: !base }, async () => {
    const response = await fetch(new URL(path, base), { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200);
    const document = new JSDOM(await response.text()).window.document;
    document.querySelectorAll("script,style,[hidden]").forEach(node => node.remove());
    assert.ok(document.body.textContent.includes(text));
    assert.equal(document.querySelector('link[rel="canonical"]').href, `https://www.rooindustries.com${path}`);
    if (path === "/packages") {
      assert.ok(document.body.textContent.includes("$99.95"));
      assert.ok(document.body.textContent.includes("Lock In More FPS"));
      for (const href of ["/packages", "/faq", "/contact", "/BIOSGuide"]) {
        assert.ok(document.querySelector(`footer a[href="${href}"]`));
      }
    }
    if (path === "/faq") assert.ok(document.querySelectorAll("noscript p").length > 10);
  });
}
