const INDEXABLE_ROUTES = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/faq",
  "/contact",
  "/about",
  "/terms",
  "/privacy",
  "/meet-the-team",
  "/tools",
  "/tourney",
];

const NOINDEX_ROUTES = [
  "/booking",
  "/payment",
  "/payment-success",
  "/thank-you",
  "/upgrade-xoc",
  "/referrals/dashboard",
  "/referrals/change-password",
  "/referrals/forgot",
  "/referrals/reset",
  "/referrals/login",
  "/referrals/register",
  "/referrals/verify",
];

const STATIC_ROUTES = [...INDEXABLE_ROUTES];
const PREBUILT_ROUTES = INDEXABLE_ROUTES.filter((route) => route !== "/reviews");
const ALL_PUBLIC_ROUTES = [...INDEXABLE_ROUTES, ...NOINDEX_ROUTES];

module.exports = {
  INDEXABLE_ROUTES,
  STATIC_ROUTES,
  PREBUILT_ROUTES,
  NOINDEX_ROUTES,
  ALL_PUBLIC_ROUTES,
};
