import packageContent from "../packageContent.js";
import policyContent from "../policyContent.js";

export const UNUSED_FIELD_NOTE = "Not shown on the site yet. Edits here won't appear.";

const unused = {
  about: ["recordImage", "recordNote", "recordDetails[].sub"],
  bookingSettings: ["maxDaysAheadBooking", "ownerEmail"],
  coupon: ["title", "notes"],
  discordBanner: ["text", "mobileText"],
  faqSettings: ["eyebrow", "title", "subtitle"],
  footer: ["title", "subtitle", "description", "availability"],
  hero: ["tagline", "ctaNoteIcon", "bullets"],
  howItWorks: ["steps[].faqText", "steps[].faqLink", "steps[].iconType"],
  meetTheTeam: ["seoTitle", "seoDescription"],
  packagesSettings: ["heading", "badgeText", "subheading", "dividerText"],
  proReviewsCarousel: ["title", "subtitle"],
  review: ["title"],
  services: ["heading", "subheading", "cards", "cards[].title", "cards[].description", "cards[].iconType", "cards[].customIcon", "benchAfterLabel"],
  siteSettings: ["siteMode"],
  supportedGames: ["title", "subtitle", "showAllLabel", "showLessLabel"],
  terms: ["lastUpdated"],
};

const conditional = {
  about: { "recordDetails[].label": "hardwareStat", "recordDetails[].value": "hardwareStat" },
  package: { description: "package", checkedBullets: "package", uncheckedBullets: "package" },
  faqSection: { "questions[].question": "faq", "questions[].answer": "faq" },
  terms: { "sections[].heading": "terms", "sections[].content": "terms" },
  meetTheTeam: { "sections[].cards[].bio": "team" },
  services: Object.fromEntries(["gameTitle", "gameLogo", "beforeFps", "afterFps", "metricLabel", "gpu", "cpu", "ram"].map(name => [`benchPages[].games[].${name}`, "overwatch"])),
};

export const isUnusedField = (field, parent = {}) => {
  if (field.unusedOnSite) return true;
  switch (field.unusedWhen) {
    case "package": {
      const override = packageContent.PACKAGE_CONTENT_OVERRIDES.find(entry => entry.matches(String(parent.title || parent.sourceTitle || "").trim()));
      return Boolean(override && Object.hasOwn(override, field.name));
    }
    case "faq": {
      const probe = { ...parent, answer: "cms-field-usage" };
      return packageContent.normalizeFaqQuestion(policyContent.applyFaqPolicyOverrides([probe])[0]).answer !== probe.answer;
    }
    case "terms": {
      const probe = { ...parent, content: [] };
      const result = policyContent.applyTermsPolicyOverrides({ sections: [probe] }).sections[0];
      return field.name === "content" ? result.content !== probe.content : result.heading !== probe.heading;
    }
    case "team": return /^(wanted|candi)$/i.test(String(parent.name || "").trim());
    case "hardwareStat": return /^(cpu|gpu)$/i.test(String(parent.label || "").trim());
    case "overwatch": return /^overwatch(?:\s+2)?$/i.test(String(parent.gameTitle || "").trim());
    default: return false;
  }
};

export const fieldUsage = (field, parent) => isUnusedField(field, parent)
  ? { ...field, readOnly: true, description: UNUSED_FIELD_NOTE }
  : field;

export const markFieldUsage = schema => {
  const visit = (fields, prefix = "") => fields.forEach(field => {
    const path = `${prefix}${field.name}`;
    if (unused[schema.name]?.includes(path)) Object.assign(field, { unusedOnSite: true, readOnly: true, preserveStoredValue: true, description: UNUSED_FIELD_NOTE });
    if (conditional[schema.name]?.[path]) Object.assign(field, { unusedWhen: conditional[schema.name][path], preserveStoredValue: true });
    if (field.fields) visit(field.fields, `${path}.`);
    for (const item of field.of || []) if (item.fields) visit(item.fields, `${path}[].`);
  });
  visit(schema.fields);
  return schema;
};
