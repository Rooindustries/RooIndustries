const INDEXABLE_ROUTES = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/meet-the-team",
  "/tools",
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
];

const STATIC_ROUTES = [...INDEXABLE_ROUTES];
const ALL_PUBLIC_ROUTES = [...INDEXABLE_ROUTES, ...NOINDEX_ROUTES];

module.exports = {
  INDEXABLE_ROUTES,
  STATIC_ROUTES,
  NOINDEX_ROUTES,
  ALL_PUBLIC_ROUTES,
};
