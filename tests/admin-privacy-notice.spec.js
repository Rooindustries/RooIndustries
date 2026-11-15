const { test, expect } = require("@playwright/test");
const { adminControl, cms, login, choose, evidence, prepareAdminContext } = require("./fixtures/admin-content.cjs");
const { COOKIE_NOTICE } = require("../src/lib/cookieNotice.js");

test.beforeEach(prepareAdminContext);

test("the privacy editor never loads or saves the code-owned cookie notice", async ({ page, request }, testInfo) => {
  const cookieSections = sections => (sections || []).filter(section => section?.heading === COOKIE_NOTICE.heading);
  const original = await cms(request, "/api/admin/content/documents/tooling-privacyPolicy");
  expect(cookieSections(original.document.sections)).toEqual([]);
  const title = `Privacy saved ${original.revision}`;
  try {
    await login(page); await choose(page, "Privacy Policy Page");
    await expect(page.getByLabel("Page Title", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: COOKIE_NOTICE.heading, exact: true })).toHaveCount(0);
    await expect(page.getByText(COOKIE_NOTICE.heading, { exact: false })).toHaveCount(0);
    await page.getByLabel("Page Title", { exact: true }).fill(title);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    const stored = await cms(request, "/api/admin/content/documents/tooling-privacyPolicy");
    expect(stored.document.title).toBe(title);
    expect(JSON.stringify(stored.document)).not.toContain(COOKIE_NOTICE.heading);
    const sectionKeys = document => document.sections.map(section => section._key);
    expect(sectionKeys(stored.document)).toEqual(sectionKeys(original.document));
    const publicResponse = await request.get("/api/content/privacy-policy");
    expect(publicResponse.ok()).toBe(true);
    const published = (await publicResponse.json()).data;
    expect(published.title).toBe(title);
    expect(cookieSections(published.sections)).toHaveLength(1);
    await evidence(page, testInfo, { title, storedSections: stored.document.sections.length,
      publicSections: published.sections.length });
  } finally { expect((await request.post(`${adminControl()}/reset-content`)).ok()).toBe(true); }
});
