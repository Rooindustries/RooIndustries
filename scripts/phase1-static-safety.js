/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim();
  } catch {
    return "";
  }
};

const sections = [
  {
    title: "Hash / Scroll Owners",
    cmd: String.raw`rg -n "location\.hash|window\.location\.hash|hashchange|scrollTo\(|scrollIntoView|setTimeout\(.*scroll" src app -S`,
  },
  {
    title: "Unsafe JSON.parse Candidates",
    cmd: String.raw`rg -n "JSON\.parse\(" src app -S`,
  },
  {
    title: "Route Owners (App Router)",
    cmd: String.raw`find app -maxdepth 3 -type f -name 'page.jsx' | sort`,
  },
  {
    title: "Route Owners (React Router Legacy)",
    cmd: String.raw`rg -n "<Route path=" src/App.jsx -S`,
  },
  {
    title: "Metadata Owners",
    cmd: String.raw`rg -n "export const metadata|getMetadataForPath|canonical|robots" app src/lib/seo.js src/next -S`,
  },
];

const lines = [
  "# Phase 1 Static Safety Sweep",
  "",
  `- Generated: ${new Date().toISOString()}`,
  "",
  "## Single Owner Map",
  "",
  "- Section hash click owner: `src/components/Navbar.jsx`",
  "- Section hash normalization/manifest owner: `src/lib/sectionNavigation.js`",
  "- Scroll alignment coordinator owner: `src/lib/scrollCoordinator.js`",
  "- FAQ hash owner (FAQ-intent only): `src/components/Faq.jsx`",
  "- Route metadata owner: `src/lib/seo.js` + `app/**/page.jsx` exports",
  "",
];

sections.forEach(({ title, cmd }) => {
  lines.push(`## ${title}`, "");
  const out = run(cmd);
  if (!out) {
    lines.push("_No matches_", "");
    return;
  }
  lines.push("```text", out, "```", "");
});

const auditDir = path.join(process.cwd(), "audit");
fs.mkdirSync(auditDir, { recursive: true });
const outPath = path.join(auditDir, "phase1-static-safety.md");
fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(`[phase1-static-safety] wrote ${outPath}`);
