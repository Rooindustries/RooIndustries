import { useEffect, useMemo, useRef, useState } from "react";
import packagePricing from "./packagePricing";
import { trackPackageView } from "./analytics";
import { useHydrating } from "./useHydrating";
import { useBookingDialogPending } from "./bookingDialogHold";
import { reportRequestError } from "./clientRequest";
import { HOME_SECTION_DATA_KEYS, fetchHomeSectionData, readHomeSectionData } from "./homeSectionData";

const { TOP_PACKAGE_PUBLIC_TITLE, findPackageBySlug, getPackagePricePresentation, getPackageSlug } = packagePricing;
const PACKAGES = HOME_SECTION_DATA_KEYS.packagesList;
const BOOKABLE_TITLES = ["Vertex Essentials", "Performance Vertex Overhaul", TOP_PACKAGE_PUBLIC_TITLE];
const BOOKABLE_SLUGS = new Set(BOOKABLE_TITLES.map(getPackageSlug));
const PACKAGES_FROM_CODE = BOOKABLE_TITLES.map((title) => ({ title, price: getPackagePricePresentation(title).price }));

export const bookingPackagePath = (title) => {
  const slug = getPackageSlug(title);
  return slug ? `/booking?package=${encodeURIComponent(slug)}` : "/booking";
};

const slugFromSearch = (search) => {
  const slug = String(new URLSearchParams(search || "").get("package") || "").trim().toLowerCase();
  return BOOKABLE_SLUGS.has(slug) ? slug : "";
};

function usePackageFromSearch(search) {
  const hydrating = useHydrating();
  const slug = slugFromSearch(search);
  const [fetched, setFetched] = useState(null);
  const packages = hydrating || !slug ? null : fetched || readHomeSectionData(PACKAGES);
  const waiting = Boolean(slug) && !packages;
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
  return useMemo(() => (packages ? findPackageBySlug(packages, slug) : null), [packages, slug]);
}

const packageFromState = (state) => {
  if (state?.bookingPackage?.title) return state.bookingPackage;
  const data = state?.bookingData;
  if (!data?.packageTitle) return null;
  return { title: data.packageTitle, price: data.packagePrice || "", tag: data.packageTag || "" };
};

export function useNavigationPackage(location) {
  const statePackage = useMemo(() => packageFromState(location?.state), [location?.state]);
  const searchPackage = usePackageFromSearch(statePackage ? "" : location?.search);
  return statePackage || searchPackage;
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
