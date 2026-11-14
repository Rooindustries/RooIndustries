import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import packagePricing from "./packagePricing";
import { trackPackageView } from "./analytics";
import { useHydrating } from "./useHydrating";
import { useBookingDialogPending } from "./bookingDialogHold";
import { reportRequestError } from "./clientRequest";
import { HOME_SECTION_DATA_KEYS, fetchHomeSectionData, readHomeSectionData } from "./homeSectionData";

const { TOP_PACKAGE_PUBLIC_TITLE, findPackageBySlug, getPackageSlug } = packagePricing;
const PACKAGES = HOME_SECTION_DATA_KEYS.packagesList;
const DEFAULT_PACKAGE_TITLE = "Performance Vertex Overhaul";
const BOOKABLE_TITLES = ["Vertex Essentials", DEFAULT_PACKAGE_TITLE, TOP_PACKAGE_PUBLIC_TITLE];
const TITLE_BY_SLUG = new Map(BOOKABLE_TITLES.map((title) => [getPackageSlug(title), title]));
const DEFAULT_SLUG = getPackageSlug(DEFAULT_PACKAGE_TITLE);
const PRICES_ERROR = "We couldn't load package prices. Check your connection and try again.";

export const bookingPackagePath = (title) => {
  const slug = getPackageSlug(title);
  return slug ? `/booking?package=${encodeURIComponent(slug)}` : "/booking";
};

const slugFromSearch = (search) => {
  const slug = String(new URLSearchParams(search || "").get("package") || "").trim().toLowerCase();
  return TITLE_BY_SLUG.has(slug) ? slug : "";
};

function usePackagesOfRecord(needed) {
  const hydrating = useHydrating();
  const [fetched, setFetched] = useState(null);
  const [failed, setFailed] = useState(false);
  const packages = hydrating || !needed ? null : fetched || readHomeSectionData(PACKAGES);
  const loading = needed && !packages && !failed;
  useEffect(() => {
    if (hydrating || !loading) return undefined;
    let active = true;
    fetchHomeSectionData(PACKAGES).then((list) => {
      if (!active) return;
      if (Array.isArray(list)) setFetched(list);
      else setFailed(true);
    }, (error) => {
      reportRequestError(error);
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [hydrating, loading]);
  useBookingDialogPending(loading);
  const retry = useCallback(() => setFailed(false), []);
  return { packages, loading, retry };
}

const packageFromState = (state) => {
  if (state?.bookingPackage?.title) return state.bookingPackage;
  const data = state?.bookingData;
  if (!data?.packageTitle) return null;
  return { title: data.packageTitle, price: data.packagePrice || "", tag: data.packageTag || "" };
};

export function useBookingPackage(location, storedPackage) {
  const statePackage = useMemo(() => packageFromState(location.state), [location.state]);
  const priced = Boolean(statePackage?.price);
  const { packages, loading, retry } = usePackagesOfRecord(!priced);
  const slug = statePackage ? getPackageSlug(statePackage.title) : slugFromSearch(location.search);
  const storedTitle = storedPackage?.title || "";
  const choice = useMemo(() => {
    if (priced) return { navigationPackage: statePackage, bookingPackage: statePackage, pricesReady: true };
    const requested = findPackageBySlug(packages, slug);
    const ofRecord = requested || findPackageBySlug(packages, getPackageSlug(storedTitle)) ||
      findPackageBySlug(packages, DEFAULT_SLUG);
    if (ofRecord) return { navigationPackage: requested, bookingPackage: ofRecord, pricesReady: true };
    const title = statePackage?.title || TITLE_BY_SLUG.get(slug) || storedTitle || DEFAULT_PACKAGE_TITLE;
    return { navigationPackage: null, bookingPackage: { title, price: "" }, pricesReady: false };
  }, [priced, statePackage, packages, slug, storedTitle]);
  const pricesError = choice.pricesReady || loading ? "" : PRICES_ERROR;
  return { ...choice, pricesError, retryPrices: retry };
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
