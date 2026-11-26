import { normalizeLinkReferral } from "./refShape.js";
import packagePricing from "./packagePricing";
import { BOOKING_DRAFT_STORAGE_KEY, readLinkReferralFromSession, readStoredCheckoutBooking, stripReservedCode } from "./checkoutStorage";
import { salesPath } from "./salesPaths";
const { getPackageSlug, resolveKnownPackageTitle } = packagePricing;
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const trim = (v) => String(v || "").trim();
export const writeLinkReferralToSession = (code) => {
  const safe = normalizeLinkReferral(code);
  try { safe ? sessionStorage.setItem("referral_session", safe) : sessionStorage.removeItem("referral_session"); } catch {}
};
export const stripRefFromSearch = (search = "") => {
  const params = new URLSearchParams(search || "");
  if (!params.has("ref")) return null;
  params.delete("ref");
  return params.toString() ? `?${params}` : "";
};
const readDraftObj = () => { try { return JSON.parse(sessionStorage.getItem(BOOKING_DRAFT_STORAGE_KEY) || "null"); } catch { return null; } };
const draftRef = (d) =>
  d?.checkoutCodes?.referral === null ? "" : stripReservedCode(d?.checkoutCodes?.referral?.code) || stripReservedCode(d?.appliedReferral?.code) || stripReservedCode(d?.referralCode);
export const readExistingCheckoutReferral = (pkg = "", { pathname = "", search = "" } = {}) => {
  if (typeof window === "undefined") return "";
  const loc = window.location, sessionRef = readLinkReferralFromSession(), usr = window.history?.state?.usr;
  const pay = isObj(usr?.bookingData) ? usr.bookingData : readStoredCheckoutBooking();
  if ((pathname || loc.pathname) === "/payment") return stripReservedCode(pay?.referralCode) || sessionRef;
  const draft = readDraftObj(), pkgs = isObj(draft?.packages) ? draft.packages : {};
  const knownTitle = resolveKnownPackageTitle(new URLSearchParams(search || loc.search).get("package") || ""), slug = knownTitle ? getPackageSlug(knownTitle) : "";
  const title = trim(pkg) || trim(usr?.bookingPackage?.title || usr?.bookingData?.packageTitle) || (slug ? Object.keys(pkgs).find((k) => getPackageSlug(k) === slug) || knownTitle : trim(draft?.lastTitle));
  const payMatch = title && pay && trim(pay.packageTitle) === title, payR = payMatch ? stripReservedCode(pay.referralCode) : "";
  return (!(payMatch && pay.code && !payR) && title && Object.hasOwn(pkgs, title) && draftRef(pkgs[title])) || sessionRef || payR;
};
const seenArrivals = [], ATTR_PARAMS = "utm_source,utm_medium,utm_campaign,utm_content,utm_term,fbclid,gclid,ref".split(",");
export const sameOrNarrowerAttribution = (prevSearch, nextSearch) => {
  const prev = new URLSearchParams(prevSearch || ""), next = new URLSearchParams(nextSearch || "");
  return ATTR_PARAMS.every((k) => !next.get(k) || next.get(k) === prev.get(k));
};
export const captureArrivalSnapshot = ({ pathname = "", search = "", revisit = 0, entryKey = "" } = {}) => {
  const loc = typeof window !== "undefined" ? window.location : null, p = pathname || loc?.pathname || "", landingPath = loc ? salesPath(p) : null;
  if (!landingPath) return null;
  const match = (e) => e.snap.landingPath === landingPath && sameOrNarrowerAttribution(e.snap.search, search), rev = revisit ? seenArrivals.slice().reverse() : [];
  const prior = (entryKey && rev.find((e) => e.entryKey === entryKey && match(e))) || rev.find(match);
  if (prior) return { ...prior.snap, revisit: true };
  const urlRef = normalizeLinkReferral(new URLSearchParams(search).get("ref") || ""), existing = readExistingCheckoutReferral("", { pathname: p, search });
  const ignoreUrlReferral = Boolean(urlRef && existing && existing.toLowerCase() !== urlRef.toLowerCase());
  let referrerHost = "";
  try {
    const r = new URL(document.referrer);
    if (r.origin !== loc.origin) referrerHost = r.hostname.toLowerCase().slice(0, 100);
  } catch {}
  const snap = { landingPath, capturedAt: new Date().toISOString(), referrerHost, search, revisit: revisit === 2, referral: ignoreUrlReferral ? existing : urlRef || existing || "", ignoreUrlReferral, hasParams: /[?&](?:utm_|(?:fbclid|gclid|ref)=)/i.test(search) };
  if (seenArrivals.push({ entryKey, snap }) > 20) seenArrivals.shift();
  return snap;
};
