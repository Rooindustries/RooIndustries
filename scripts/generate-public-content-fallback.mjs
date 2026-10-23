import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
  try { return next(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith(".") || specifier.startsWith("file:")) && !path.extname(specifier)) return next(specifier + ".js", context);
    throw error;
  }
} });

const { loadSupabasePublicContent } = await import("../src/server/content/publicContent.js");
const { PUBLIC_CONTENT_QUERIES } = await import("../src/lib/publicContentQueries.js");
const resources = {};
let resource;
try {
  for (const [name, query] of Object.entries(PUBLIC_CONTENT_QUERIES)) {
    if (["package", "upgrade-link"].includes(name)) continue;
    resource = name;
    const data = await loadSupabasePublicContent({ resource, query, params: {}, fresh: true, allowFallback: false });
    resources[resource] = data ?? null;
  }
  const file = new URL("../src/generated/public-content.json", import.meta.url);
  fs.mkdirSync(path.dirname(fileURLToPath(file)), { recursive: true });
  const temporary = fileURLToPath(file) + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, resources }));
  fs.renameSync(temporary, file);
} catch {
  console.error(`Public content snapshot could not be built for ${resource}.`);
  process.exitCode = 1;
}
