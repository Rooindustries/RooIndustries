import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import { rules } from "../eslint-rules/index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-page-route-removal", rules["no-page-route-removal"], {
  valid: [
    "await removePageRoutes(page);",
    'await routePage(page, "**/chunk", handler);',
    'const label = { unroute: "example" };',
    'object.unroute();',
    'const object = { unroute() {} }; object.unroute();',
  ],
  invalid: [
    'removeContextRoutes(page, "**/*");',
    'test(async ({ page: tab }) => tab.unrouteAll());',
    'const tab = await context.newPage(); tab.unrouteAll();',
    'await page.unrouteAll({ behavior: "wait" });',
    'await page.unroute("**/_next/static/chunks/**", interceptChunk);',
    'const tab = page; const remove = tab.unroute; remove("**/chunk");',
    'page["unrouteAll"]();',
    'page[`unroute`]();',
    'const method = "unrouteAll"; page[method]();',
    'const { unroute: remove } = page;',
    'const { "unrouteAll": remove } = page;',
    'const { ["unroute"]: remove } = page;',
  ].map(code => ({ code, errors: [{ messageId: "removal" }] })),
});
