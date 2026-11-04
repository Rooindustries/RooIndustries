const { test, expect } = require("@playwright/test");
const { CONTENT_READ, createContentGate } = require("./fixtures/content-store-gate.cjs");

const TARGET_PACKAGE = "tooling-package-0";
const TARGET_LINK = "fixture-upgradeLink";
const UPGRADE_LINK = "/api/content/upgrade-link?slug=fixture-upgrade";

test("content reads carry the CMS revision they came from, even when a publish lands between their reads", async ({ request, baseURL }) => {
  test.setTimeout(120000);
  const gate = createContentGate(request, baseURL);
  const original = await gate.document(TARGET_PACKAGE);
  const originalLink = await gate.document(TARGET_LINK);
  const before = await (await gate.traced().content(UPGRADE_LINK)).json();
  expect(before).toMatchObject({ ok: true, data: { title: originalLink.document.title, targetPackage: { price: original.document.price } } });
  expect(Number.isSafeInteger(before.revision)).toBe(true);

  try {
    await gate.publish(original, { price: "$188.88" });
    const listed = await (await gate.traced().content("/api/content/packages-list")).json();
    expect(listed.revision).toBe(before.revision + 1);
    expect(listed.data.find((row) => row._id === TARGET_PACKAGE)?.price).toBe("$188.88");

    const straddled = gate.traced();
    await straddled.rules([{ rpc: CONTENT_READ, action: "hold", times: 1 }]);
    const pending = straddled.content(UPGRADE_LINK);
    await straddled.waitForHold();
    expect(await straddled.contentReads()).toHaveLength(1);
    await gate.publishElsewhere(originalLink, { title: "Straddled upgrade title" });
    await gate.publishElsewhere(await gate.document(TARGET_PACKAGE), { price: "$211.11" });
    await straddled.release();
    const answer = await (await pending).json();

    expect(answer).toMatchObject({
      ok: true,
      revision: before.revision + 3,
      data: { title: "Straddled upgrade title", targetPackage: { price: "$211.11" } },
    });
    expect(await straddled.contentReads()).toHaveLength(4);
  } finally {
    await gate.restore(TARGET_PACKAGE, original.document);
    await gate.restore(TARGET_LINK, originalLink.document);
  }
});
