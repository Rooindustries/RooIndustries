import { writeFile } from "node:fs/promises";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const root = "/Users/serviroo/worktrees/email-template";
const moduleUrl = pathToFileURL(
  `${root}/src/server/api/ref/bookingEmails.js`
).href;
const outputPath = `${root}/email-render-proof.html`;
const hook = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url === ${JSON.stringify(`${moduleUrl}?render-proof`)}) {
    return { ...loaded, source: loaded.source + "\\nexport { emailHtml };" };
  }
  return loaded;
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
Object.assign(process.env, {
  DATA_PRIMARY_BACKEND: "sanity",
  COMMERCE_PRIMARY_BACKEND: "sanity",
  SANITY_PROJECT_ID: "renderproof",
  SANITY_DATASET: "production",
  SANITY_WRITE_TOKEN: "render-proof-token",
});

const { emailHtml } = await import(`${moduleUrl}?render-proof`);
const html = emailHtml({
  logoUrl: "https://www.rooindustries.com/embed_logo.png",
  siteName: "Roo Industries",
  heading: "Booking Received ✨",
  intro:
    "To continue with your booking, please join the Roo Industries Discord using the button above. I'll contact you there (or by email if needed) to confirm your time and details.",
  fields: [
    { label: "Package", value: "Performance Vertex Overhaul" },
    { label: "Date & time", value: "Sunday, 19 July 2026 · 9:00 PM IST" },
    { label: "Discord", value: "@servi_preview" },
  ],
  discordInviteUrl: "https://discord.com/invite/qs5HKNyazD",
});

await writeFile(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, bytes: Buffer.byteLength(html) }));
