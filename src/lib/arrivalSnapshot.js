import { normalizeLinkReferral } from "./refShape.js";
import packagePricing from "./packagePricing";
import { BOOKING_DRAFT_STORAGE_KEY, extractTokenNonce, readLinkReferralFromSession, readSessionJson, readStoredCheckoutBooking, stripReservedCode } from "./checkoutStorage";
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
const isTerminalPay = (b) => {
  const term = readSessionJson("roo_terminal_reservations");
  if (!term) return false;
  const o = trim(b.originalOrderId), p = trim(b.packageTitle), e = trim(b.email).toLowerCase(), h = trim(b.slotHoldId || b.holdId), t = trim(b.startTimeUTC);
  const d = o ? { k: "u", o, i: extractTokenNonce(b.upgradeIntentToken || b.upgradeIntentId), p, e }
    : h || t ? { k: "b", h, n: extractTokenNonce(b.slotHoldToken || b.holdToken), p, t, e } : 0;
  if (!d) return false;
  if (o) return Boolean(term[JSON.stringify(d)]);
  const rot = (h && readSessionJson("roo_hold_rotations")) || {};
  for (let c = d.n, seen = {}; ; seen[c] = 1, c = rot[`${h}:${c}`]) {
    if (term[JSON.stringify({ ...d, n: c })]) return true;
    if (!c || seen[c] || !rot[`${h}:${c}`]) return false;
  }
};
const draftRef = (d) =>
  d?.checkoutCodes?.referral === null ? "" : stripReservedCode(d?.checkoutCodes?.referral?.code) || stripReservedCode(d?.appliedReferral?.code) || stripReservedCode(d?.referralCode);
export const readExistingCheckoutReferral = (pkg = "", { pathname = "", search = "" } = {}) => {
  if (typeof window === "undefined") return "";
  const loc = window.location, sessionRef = readLinkReferralFromSession(), usr = window.history?.state?.usr;
  const pay = [usr?.bookingData, readStoredCheckoutBooking()].find((b) => isObj(b) && !isTerminalPay(b)) || null;
  if ((pathname || loc.pathname) === "/payment") return stripReservedCode(pay?.referralCode) || sessionRef;
  const draft = readSessionJson(BOOKING_DRAFT_STORAGE_KEY), pkgs = isObj(draft?.packages) ? draft.packages : {};
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
