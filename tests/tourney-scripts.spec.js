const { test, expect } = require("@playwright/test");

const LEGACY_APP_CHUNK = /\/_next\/static\/chunks\/(app\/page-|roo-motion-)/;

test("/tourney loads none of the main site's app scripts", async ({ request }, testInfo) => {
  const response = await request.get("/tourney", { headers: { accept: "text/html" } });
  const html = await response.text();
  const scripts = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(match => match[1]))];
  await testInfo.attach("tourney-scripts", { body: JSON.stringify(scripts, null, 2), contentType: "application/json" });
  expect(response.status()).toBe(200);
  expect(scripts.some(src => src.includes("/chunks/app/tourney/page-"))).toBe(true);
  expect(scripts.filter(src => LEGACY_APP_CHUNK.test(src))).toEqual([]);
});
