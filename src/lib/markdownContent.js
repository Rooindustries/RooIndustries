const { HOME_COPY } = require("./homeCopy");
const { ABOUT_PARAGRAPHS, CONTACT_EMAIL, CONTACT_GUIDANCE } = require("./companyContent");
const { SITE_URL } = require("./seo");

const MARKDOWN_PATHS = ["/", "/about", "/contact", "/privacy"];
const MARKDOWN_VARY = "Accept, Accept-Encoding";
const RECOVERY_LINKS = [
  ["Home", "/"],
  ["Site map", "/sitemap.xml"],
  ["Agent instructions", "/llms.txt"],
  ["Packages", "/packages"],
  ["Contact", "/contact"],
];

const links = (items) => items.map(([title, path]) => `- [${title}](${SITE_URL}${path})`).join("\n");
const escapeMarkdown = (text = "") => String(text).replace(/([\\`*_{}\[\]<>#+.!|~-])/g, "\\$1");

function buildPageMarkdown(pathname, privacy = null) {
  const { hero, services, howItWorks } = HOME_COPY;
  switch (pathname) {
    case "/":
      return [
        `# ${hero.headingLine1} ${hero.headingLine2}`,
        hero.description,
        hero.subtext,
        `## ${services.heading}`,
        services.subheading,
        ...services.cards.map((card) => `- **${card.title}**: ${card.description}`),
        `## ${howItWorks.title}`,
        ...howItWorks.steps.map((step, i) => `${i + 1}. **${step.title}**: ${step.text}`),
        "## Packages, results, and support",
        "Read the current package pages for pricing and scope, and the service terms for refund and warranty conditions. Results depend on the PC and game.",
        links([["Packages", "/packages"], ["Benchmarks", "/benchmarks"], ["Reviews", "/reviews"], ["FAQ", "/faq"], ["About", "/about"], ["Contact", "/contact"], ["Privacy", "/privacy"], ["Terms", "/terms"]]),
      ].join("\n\n") + "\n";
    case "/about":
      return ["# About Roo Industries", ...ABOUT_PARAGRAPHS, "## Learn more", links([["Meet the team", "/meet-the-team"], ["Packages", "/packages"], ["Benchmarks", "/benchmarks"], ["Reviews", "/reviews"], ["Contact", "/contact"], ["Terms", "/terms"], ["Privacy", "/privacy"]])].join("\n\n") + "\n";
    case "/contact":
      return ["# Contact Roo Industries", `Email: [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL})`, ...CONTACT_GUIDANCE, links([["Contact form", "/contact"], ["Packages", "/packages"], ["FAQ", "/faq"], ["Terms", "/terms"]])].join("\n\n") + "\n";
    case "/privacy":
      if (!privacy?.sections?.length) return null;
      return [
        `# ${escapeMarkdown(privacy.title || "Privacy Policy")}`,
        ...privacy.sections.flatMap((section) => [
          ...(section.heading ? [`## ${escapeMarkdown(section.heading)}`] : []),
          ...(section.content || []).filter((block) => block._type === "block").map((block) => {
            const text = escapeMarkdown((block.children || []).map((span) => span.text || "").join(""));
            return block.listItem ? `- ${text}` : text;
          }),
        ]),
        ...(privacy.lastUpdated ? [`Last updated: ${escapeMarkdown(privacy.lastUpdated)}`] : []),
        `[Contact Roo Industries](mailto:${CONTACT_EMAIL})`,
      ].join("\n\n") + "\n";
    default:
      return null;
  }
}

const NOT_FOUND_MARKDOWN = [
  "# 404 — Page not found",
  "This path does not exist. Use the site map to find a published page, or start with the agent instructions and packages.",
  links(RECOVERY_LINKS),
].join("\n\n") + "\n";

module.exports = { MARKDOWN_PATHS, MARKDOWN_VARY, NOT_FOUND_MARKDOWN, buildPageMarkdown };
