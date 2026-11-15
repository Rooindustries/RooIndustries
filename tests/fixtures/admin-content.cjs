const fs = require("node:fs/promises");
const { expect } = require("@playwright/test");
const { fixturePort } = require("./fixture-ports.cjs");

const ADMIN_KEY = "synthetic-admin-key";
const EMAIL = "content-admin@example.invalid";
const PASSWORD = "Synthetic-Content-Password-123";

const adminControl = () => `http://127.0.0.1:${fixturePort("TOOLING_ADMIN_CONTROL_PORT")}`;

const cms = async (request, path, body) => {
  const response = await request.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-admin-key": ADMIN_KEY },
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
};

const login = async (page) => {
  await page.goto("/admin/content");
  await page.getByLabel("Email", { exact: true }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
};

const choose = async (page, title) => {
  const navigation = page.getByRole("navigation", { name: "Content types", includeHidden: true });
  await expect(navigation).toBeAttached();
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Types", exact: true }).first().click();
  await navigation.getByRole("button", { name: title, exact: true }).click();
};

const evidence = async (page, testInfo, details) => {
  const json = testInfo.outputPath("result.json");
  await fs.writeFile(json, JSON.stringify(details, null, 2));
  await testInfo.attach("result", { path: json, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("result.png"), fullPage: true });
};

const prepareAdminContext = async ({ context, page, request, baseURL }) => {
  page.setDefaultTimeout(10000);
  const { guardBrowserContext, localOrigin } = await import("../../scripts/lib/test-target-safety.mjs");
  const control = localOrigin(adminControl());
  const markerResponse = await request.get(`${control}/fixture`);
  expect(markerResponse.ok(), "The native fixture must attest before admin I/O").toBe(true);
  const marker = await markerResponse.json();
  expect(marker).toMatchObject({ version: 1, isolated: true, baseURL: localOrigin(baseURL) });
  expect(marker.versions.postgres).toContain("17.");
  await guardBrowserContext(context, marker.origins);
  expect((await request.post(`${control}/reset-rate-limits`)).ok()).toBe(true);
  // Secure cookies are preserved in the product. Synthetic fixture HTTP needs this on private-IP hosts.
  await context.route("**/api/admin/content/session", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].replace(/; Secure(?=;|$)/gi, "");
    await route.fulfill({ response, headers });
  });
};

module.exports = { ADMIN_KEY, EMAIL, PASSWORD, adminControl, cms, login, choose, evidence, prepareAdminContext };
