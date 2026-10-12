import packageContent from "../packageContent.js";
import policyContent from "../policyContent.js";

export const UNUSED_FIELD_NOTE = "Not shown on the site yet. Edits here won't appear.";

const unused = {
  about: ["recordImage", "recordNote", "recordDetails[].sub"],
  bookingSettings: ["maxDaysAheadBooking"],
  coupon: ["notes"],
  discordBanner: ["text", "mobileText"],
  faqSettings: ["eyebrow", "title", "subtitle"],
  footer: ["title", "subtitle", "description", "availability"],
  hero: ["tagline", "ctaNoteIcon", "bullets"],
  howItWorks: ["steps[].faqText", "steps[].faqLink", "steps[].iconType"],
  meetTheTeam: ["seoTitle", "seoDescription"],
  packagesSettings: ["heading", "badgeText", "subheading", "dividerText"],
  proReviewsCarousel: ["title", "subtitle"],
  services: ["heading", "subheading", "cards", "cards[].title", "cards[].description", "cards[].iconType", "cards[].customIcon", "benchAfterLabel"],
  siteSettings: ["siteMode"],
  supportedGames: ["title", "subtitle", "showAllLabel", "showLessLabel"],
  terms: ["lastUpdated"],
};

const conditional = {
  about: { "recordDetails[].value": "hardwareStat" },
  package: { description: "package", checkedBullets: "package", uncheckedBullets: "package" },
  faqSection: { "questions[].answer": "faq" },
  terms: { "sections[].content": "terms" },
  meetTheTeam: { "sections[].cards[].bio": "team", "sections[].cards[].platformBadge": "standardCard", "sections[].cards[].ctaLabel": "standardCard", "sections[].cards[].ctaUrl": "standardCard", "sections[].cards[].tags": "ambassadorCard" },
  services: Object.fromEntries(["gameLogo", "beforeFps", "afterFps", "metricLabel", "gpu", "cpu", "ram"].map(name => [`benchPages[].games[].${name}`, "overwatch"])),
};

const overrideKeys = {
  about: ["recordDetails[].label"],
  faqSection: ["questions[].question"],
  package: ["title"],
  meetTheTeam: ["sections[].cards[].name", "sections[].variant"],
  services: ["benchPages[].games[].gameTitle"],
  terms: ["sections[].heading"],
};

export const fieldUsageContext = (fields, value, context = {}) => fields.some(field => field.name === "variant")
  ? { ...context, variant: value?.variant }
  : context;

export const isUnusedField = (field, parent = {}, context = {}) => {
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
      return result.content !== probe.content;
    }
    case "standardCard": return context.variant !== "ambassador";
    case "ambassadorCard": return context.variant === "ambassador";
    case "team": return /^(wanted|candi)$/i.test(String(parent.name || "").trim());
    case "hardwareStat": return /^(cpu|gpu)$/i.test(String(parent.label || "").trim());
    case "overwatch": return /^overwatch(?:\s+2)?$/i.test(String(parent.gameTitle || "").trim());
    default: return false;
  }
};

export const fieldUsage = (field, parent, context) => isUnusedField(field, parent, context)
  ? { ...field, readOnly: true, description: UNUSED_FIELD_NOTE }
  : field;

export const markFieldUsage = schema => {
  const visit = (fields, prefix = "") => fields.forEach(field => {
    const path = `${prefix}${field.name}`;
    if (overrideKeys[schema.name]?.includes(path)) field.overrideKey = true;
    if (unused[schema.name]?.includes(path)) Object.assign(field, { unusedOnSite: true, readOnly: true, preserveStoredValue: true, description: UNUSED_FIELD_NOTE });
    if (conditional[schema.name]?.[path]) Object.assign(field, { unusedWhen: conditional[schema.name][path], preserveStoredValue: true });
    if (field.fields) visit(field.fields, `${path}.`);
    for (const item of field.of || []) if (item.fields) visit(item.fields, `${path}[].`);
  });
  visit(schema.fields);
  return schema;
};
