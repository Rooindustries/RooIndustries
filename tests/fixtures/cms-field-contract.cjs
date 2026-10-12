const { createHash } = require("node:crypto");

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

const bindings = {
  about: { resource: "about", page: "/" },
  benchmark: { resource: "benchmarks", page: "/benchmarks" },
  bookingSettings: { endpoint: "/api/bookingAvailability" },
  contact: { resource: "contact", page: "/contact", api: ["formId"] },
  coupon: { endpoint: "/api/ref/validateCoupon" },
  discordBanner: { resource: "discord-banner", page: "/" },
  faqSection: { resource: "faq-questions", page: "/faq" },
  faqSettings: {},
  footer: {},
  hero: { resource: "hero", page: "/" },
  howItWorks: { resource: "how-it-works", page: "/" },
  meetTheTeam: { resource: "team", page: "/meet-the-team", api: ["sections[].variant", "founder.socialLinks[].icon", "sections[].cards[].initials", "sections[].cards[].platformBadge", "sections[].cards[].ctaLabel", "sections[].cards[].ctaUrl", "sections[].cards[].tags"] },
  package: { resource: "packages-list", page: "/packages", api: ["features[]"] },
  packagesSettings: {},
  privacyPolicy: { resource: "privacy-policy", page: "/privacy" },
  proReviewsCarousel: { resource: "reviews", page: "/", api: ["reviews[].optimizationResult"] },
  referralBox: { resource: "referral-box", page: "/", api: ["registerPath", "loginPath"] },
  review: { resource: "reviews-gallery", page: "/reviews" },
  services: { resource: "services", page: "/" },
  siteSettings: {},
  supportedGames: { resource: "supported-games", page: "/" },
  terms: { resource: "terms", page: "/terms" },
  tool: { resource: "tools", page: "/tools" },
  upgradeLink: { resource: "upgrade-link", api: ["title", "intro", "slug", "targetPackage"] },
};

const hash = value => createHash("sha1").update(value).digest("hex");
const patternPath = path => path.replace(/\[\d+\]/g, "[]");
const unusedField = (type, field, parent = {}) => {
  if ((unused[type] || []).includes(patternPath(field))) return true;
  if (type === "about" && /\.(?:label|value)$/.test(field)) return /^(cpu|gpu)$/i.test(String(parent.label || "").trim());
  if (type === "package" && /^(?:checkedBullets|uncheckedBullets)$/.test(field)) return /^(?:vertex essentials|performance vertex overhaul|performance vertex max|xoc(?:\s*\/\s*extreme overclocking)?)$/i.test(parent.title || "");
  if (type === "package" && field === "description") return /^(?:performance vertex max|xoc(?:\s*\/\s*extreme overclocking)?)$/i.test(parent.title || "");
  if (type === "faqSection" && /\.(?:question|answer)$/.test(field)) return /(?:refund|money[- ]back).*warranty|warranty.*(?:refund|money[- ]back)|free re[-\s]?optimization|(?:re[-\s]?xoc|rexoc).*free|upgrade pc each 6 months|change a part before the 6[-\s]?month period/i.test(parent.question || "");
  if (type === "terms" && /\.content$/.test(field)) return /payments and refunds|rescheduling policy|cancellations and rescheduling/i.test(parent.heading || "");
  if (type === "terms" && /\.heading$/.test(field)) return /rescheduling policy|cancellations and rescheduling/i.test(parent.heading || "");
  if (type === "meetTheTeam" && /\.bio$/.test(field)) return /^(?:wanted|candi)$/i.test(String(parent.name || "").trim());
  if (type === "services" && /^benchPages\[\d+\]\.games\[\d+\]\./.test(field)) return /^overwatch(?:\s+2)?$/i.test(String(parent.gameTitle || "").trim());
  return false;
};

const schemaFields = (fields, prefix = "") => fields.flatMap(field => {
  const path = `${prefix}${field.name}`;
  return [{ field, path },
    ...(field.fields ? schemaFields(field.fields, `${path}.`) : []),
    ...(field.of || []).flatMap(item => item.fields ? schemaFields(item.fields, `${path}[].`) : []),
    ...(field.of || []).flatMap(item => (item.annotations || []).flatMap(annotation => schemaFields(annotation.fields || [], `${path}[].markDefs[].`))),
  ];
});

async function buildDocument({ schema, current, marker, origin, upload, reference, preserveUnused = false }) {
  const cases = [];
  const mark = path => `${marker}-${schema.name}-${path.replace(/[^a-z0-9]/gi, "-")}`;
  const fields = async (definitions, previous, prefix = "") => {
    const object = structuredClone(previous || {});
    for (const field of definitions) {
      const path = `${prefix}${field.name}`;
      if (field.readOnly && !field.preserveStoredValue) continue;
      if (preserveUnused && unusedField(schema.name, path, object)) continue;
      object[field.name] = await value(field, previous?.[field.name], path);
    }
    return object;
  };
  const value = async (field, previous, path) => {
    const token = mark(path);
    let next;
    if (field.type === "object") next = await fields(field.fields || [], previous, `${path}.`);
    else if (field.type === "array") {
      const item = field.of?.[0];
      if (item?.type === "block") {
        const href = `${origin}/cms-marker/${token}-link`;
        next = [{ _key: hash(path), _type: "block", style: "normal", markDefs: [{ _key: "link", _type: "link", href }], children: [{ _key: "span", _type: "span", text: token, marks: ["link"] }] }];
        cases.push({ field: { type: "url" }, path: `${path}[0].markDefs[0].href`, token: `${token}-link`, value: href });
      } else if (item?.type === "object") {
        const count = schema.name === "meetTheTeam" && path === "sections" || schema.name === "services" && path === "benchPages" ? 2 : 1;
        next = [];
        for (let index = 0; index < count; index++) {
          const row = await fields(item.fields || [], { ...(previous?.[index] || {}), _key: hash(`${path}-${index}`), _type: item.name || "object" }, `${path}[${index}].`);
          if (schema.name === "meetTheTeam" && path === "sections") row.variant = (preserveUnused ? index : !index) ? "ambassador" : "standard";
          next.push(row);
        }
      } else if (item?.type === "reference") {
        next = [{ _key: hash(path), _type: "reference", _ref: await reference(token) }];
        cases.push({ field: item, path: `${path}[0]`, value: next[0], token, bare: true });
      } else {
        const option = field.options?.list?.[preserveUnused ? field.options.list.length - 1 : 0];
        next = option ? [option.value ?? option] : [token];
        cases.push({ field: item, path: `${path}[0]`, value: next[0], token: next[0], bare: true, listed: Boolean(field.options?.list) });
      }
    } else if (["image", "file"].includes(field.type)) next = { _type: field.type, asset: { _type: "reference", _ref: await upload(field.type, token) } };
    else if (field.type === "reference") next = { _type: "reference", _ref: await reference(token) };
    else if (field.type === "slug") next = { _type: "slug", current: token.toLowerCase().slice(0, 80) };
    else if (field.options?.list) { const option = field.options.list[preserveUnused ? field.options.list.length - 1 : 0]; next = option.value ?? option; }
    else if (field.type === "boolean") next = preserveUnused;
    else if (field.type === "number") next = schema.name === "coupon" && path === "discountPercent" ? (preserveUnused ? 37 : 11) : Math.min(field.max ?? 999999, Math.max(field.min ?? 0, (preserveUnused ? 1000 : 100) + Number.parseInt(hash(path).slice(0, 3), 16)));
    else if (field.type === "date") next = `${preserveUnused ? 2099 : 2098}-02-${String(1 + Number.parseInt(hash(path).slice(0, 2), 16) % 27).padStart(2, "0")}`;
    else if (field.type === "datetime") next = /validFrom$/.test(path) ? `${preserveUnused ? 2020 : 2019}-01-01T00:00:00.000Z` : `${preserveUnused ? 2099 : 2098}-01-01T00:00:00.000Z`;
    else if (field.type === "url") next = `${origin}/cms-marker/${token}`;
    else if (field.email || /(?:ownerEmail|email)$/.test(path)) next = `${token.toLowerCase()}@fixture.invalid`;
    else if (schema.name === "package" && path === "price") next = preserveUnused ? "$321.67" : "$123.45";
    else if (schema.name === "coupon" && path === "code") next = hash(token).slice(0, 16);
    else if (schema.name === "referralBox" && /Path$/.test(path)) next = `/referrals/${path === "registerPath" ? "register" : "login"}?cms=${token}`;
    else if (schema.name === "proReviewsCarousel" && /optimizationResult$/.test(path)) next = `${token}: 321 -> 654`;
    else next = token;
    cases.push({ field, path, token: typeof next === "string" && next.includes(token) ? token : next, value: next });
    return next;
  };
  const document = await fields(schema.fields, current);
  if (schema.name === "meetTheTeam") for (const item of cases.filter(item => /sections\[\d+\]\.variant$/.test(item.path))) item.value = item.token = get(document, item.path);
  if (schema.name === "services") {
    const fallback = structuredClone(document.benchPages[0].games[0]);
    fallback._key = "metric-fallback";
    fallback.gameTitle += " fallback";
    delete fallback.metricLabel;
    document.benchPages[0].games.push(fallback);
  }
  return { document, cases };
}

const get = (document, path) => path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce((value, key) => value?.[key], document);

module.exports = { unused, bindings, unusedField, schemaFields, buildDocument, patternPath, get };
