import packagePricing from "./packagePricing";

export const bookingPackagePath = (title) => {
  const slug = packagePricing.getPackageSlug(title);
  return slug ? `/booking?package=${encodeURIComponent(slug)}` : "/booking";
};
