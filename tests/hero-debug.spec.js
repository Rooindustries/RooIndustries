const { test, devices } = require("@playwright/test");

test("debug page content", async ({ browser }) => {
  const ctx = await browser.newContext({ 
    viewport: { width: 1280, height: 800 }, 
    javaScriptEnabled: true 
  });
  const page = await ctx.newPage();
  
  // Listen for console messages
  page.on("console", msg => console.log("CONSOLE:", msg.type(), msg.text()));
  page.on("pageerror", err => console.log("PAGE_ERROR:", err.message));
  
  const resp = await page.goto("/", { waitUntil: "networkidle", timeout: 60000 });
  console.log("STATUS:", resp.status());
  console.log("URL:", page.url());
  
  await page.waitForTimeout(3000);
  
  const html = await page.evaluate(() => {
    return {
      title: document.title,
      bodyChildCount: document.body.children.length,
      firstChildTag: document.body.children[0]?.tagName,
      h1Count: document.querySelectorAll("h1").length,
      headerCount: document.querySelectorAll("header").length,
      bodyText: document.body.innerText.substring(0, 500),
      rootHTML: document.getElementById("root")?.innerHTML?.substring(0, 300) || "(no #root)",
      nextHTML: document.getElementById("__next")?.innerHTML?.substring(0, 300) || "(no __next)",
    };
  });
  
  console.log("\n=== DEBUG ===");
  console.log(JSON.stringify(html, null, 2));
  await ctx.close();
});
