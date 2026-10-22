const CANONICAL_URL = /((?:^|\n|\[1,")0:\{\\?"P\\?":[^,]*,\\?"b\\?":\\?"[^"\\]*\\?",\\?"p\\?":\\?"[^"\\]*\\?",)\\?"c\\?":\[[^\]]*\]/g;

const withoutCanonicalUrl = (text) => String(text).replace(CANONICAL_URL, "$1");

module.exports = { withoutCanonicalUrl };
