const CANONICAL_URL = /(\\?"p\\?":\\?"[^"\\]*\\?",)\\?"c\\?":\[[^\]]*\]/g;

const withoutCanonicalUrl = (text) => String(text).replace(CANONICAL_URL, "$1");

module.exports = { withoutCanonicalUrl };
