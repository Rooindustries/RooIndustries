import { useEffect, useMemo, useRef, useState } from "react";
import packagePricing from "./packagePricing";
import { trackPackageView } from "./analytics";
import { useHydrating } from "./useHydrating";
import { useBookingDialogPending } from "./bookingDialogHold";
import { reportRequestError } from "./clientRequest";
import { HOME_SECTION_DATA_KEYS, fetchHomeSectionData, readHomeSectionData } from "./homeSectionData";

const { TOP_PACKAGE_PUBLIC_TITLE, findPackageBySlug, getPackagePricePresentation, getPackageSlug } = packagePricing;
const PACKAGES = HOME_SECTION_DATA_KEYS.packagesList;
const DEFAULT_PACKAGE_TITLE = "Performance Vertex Overhaul";
const BOOKABLE_TITLES = ["Vertex Essentials", DEFAULT_PACKAGE_TITLE, TOP_PACKAGE_PUBLIC_TITLE];
const BOOKABLE_SLUGS = new Set(BOOKABLE_TITLES.map(getPackageSlug));
const DEFAULT_SLUG = getPackageSlug(DEFAULT_PACKAGE_TITLE);
const PACKAGES_FROM_CODE = BOOKABLE_TITLES.map((title) => ({ title, price: getPackagePricePresentation(title).price }));
const DEFAULT_FROM_CODE = findPackageBySlug(PACKAGES_FROM_CODE, DEFAULT_SLUG);

export const bookingPackagePath = (title) => {
  const slug = getPackageSlug(title);
  return slug ? `/booking?package=${encodeURIComponent(slug)}` : "/booking";
};

const slugFromSearch = (search) => {
  const slug = String(new URLSearchParams(search || "").get("package") || "").trim().toLowerCase();
  return BOOKABLE_SLUGS.has(slug) ? slug : "";
};

function usePackagesOfRecord(needed) {
  const hydrating = useHydrating();
  const [fetched, setFetched] = useState(null);
  const packages = hydrating || !needed ? null : fetched || readHomeSectionData(PACKAGES);
  const waiting = needed && !packages;
  useEffect(() => {
    if (hydrating || !waiting) return undefined;
    let active = true;
    fetchHomeSectionData(PACKAGES).catch((error) => {
      reportRequestError(error);
      return PACKAGES_FROM_CODE;
    }).then((list) => {
      if (active) setFetched(list);
    });
    return () => {
      active = false;
    };
  }, [hydrating, waiting]);
  useBookingDialogPending(waiting);
  return packages;
}

const packageFromState = (state) => {
  if (state?.bookingPackage?.title) return state.bookingPackage;
  const data = state?.bookingData;
  if (!data?.packageTitle) return null;
  return { title: data.packageTitle, price: data.packagePrice || "", tag: data.packageTag || "" };
};

export function useBookingPackage(location, storedPackage) {
  const statePackage = useMemo(() => packageFromState(location?.state), [location?.state]);
  const slug = statePackage ? "" : slugFromSearch(location?.search);
  const packages = usePackagesOfRecord(!statePackage);
  return useMemo(() => {
    if (statePackage) return { navigationPackage: statePackage, bookingPackage: statePackage };
    const requestedPackage = findPackageBySlug(packages || PACKAGES_FROM_CODE, slug);
    const navigationPackage = packages ? requestedPackage : null;
    const storedOfRecord = storedPackage?.title
      ? findPackageBySlug(packages, getPackageSlug(storedPackage.title)) || storedPackage
      : null;
    const bookingPackage = requestedPackage || storedOfRecord ||
      findPackageBySlug(packages, DEFAULT_SLUG) || DEFAULT_FROM_CODE;
    return { navigationPackage, bookingPackage };
  }, [statePackage, packages, slug, storedPackage]);
}

export function useBookingPackageView(pkg) {
  const trackedTitle = useRef("");
  const title = pkg?.title || "";
  const price = pkg?.price || "";
  useEffect(() => {
    if (!title || trackedTitle.current === title) return;
    trackedTitle.current = title;
    trackPackageView({ title, price, surface: "booking" });
  }, [title, price]);
}
