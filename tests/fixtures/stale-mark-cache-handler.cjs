const FileSystemCache = require("next/dist/server/lib/incremental-cache/file-system-cache.js").default;

const marks = (globalThis[Symbol.for("roo.test.pageMarks")] ||= { at: 0 });

module.exports = class StaleMarkCache extends FileSystemCache {
  async set(key, data, ctx) {
    const controls = globalThis[Symbol.for("roo.test.controls")];
    if (controls?.storeDelayMs > 0 && data?.kind === "APP_PAGE") {
      const ms = controls.storeDelayMs;
      controls.storeDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const result = await super.set(key, data, ctx);
    if (data?.kind === "APP_PAGE" && process.env.ROO_CONTENT_TEST_CONTROL_URL) {
      const route = key.split("/$/").at(-1);
      await fetch(`${process.env.ROO_CONTENT_TEST_CONTROL_URL}/test-page-write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: route === "index" ? "/" : `/${route}` }) });
    }
    return result;
  }

  async get(key, ctx) {
    const data = await super.get(key, ctx);
    const tags = String(data?.value?.headers?.["x-next-cache-tags"] || "").split(",");
    if (data && data.lastModified > 0 && data.lastModified < marks.at && tags.includes("_N_T_/layout")) return { ...data, lastModified: -1 };
    return data;
  }
};
