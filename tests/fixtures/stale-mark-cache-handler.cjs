const FileSystemCache = require("next/dist/server/lib/incremental-cache/file-system-cache.js").default;

const marks = (globalThis[Symbol.for("roo.test.pageMarks")] ||= { at: 0 });

module.exports = class StaleMarkCache extends FileSystemCache {
  async get(key, ctx) {
    const data = await super.get(key, ctx);
    const tags = String(data?.value?.headers?.["x-next-cache-tags"] || "").split(",");
    if (data && data.lastModified > 0 && data.lastModified < marks.at && tags.includes("_N_T_/layout")) return { ...data, lastModified: -1 };
    return data;
  }
};
