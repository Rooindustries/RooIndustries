import { normalizeLinkReferral } from "./refShape.js";
import { readExistingCheckoutReferral } from "./arrivalSnapshot";
export default (search, initial = false, pathname = "", href = "") => {
  if (typeof window === "undefined" || (href && window.location.href !== href)) return;
  if (initial && performance.getEntriesByType?.("navigation")?.[0]?.type === "back_forward") return;
  const code = normalizeLinkReferral(new URLSearchParams(search || "").get("ref") || "");
  if (!code || readExistingCheckoutReferral("", { pathname: pathname || window.location.pathname, search })) return;
  try { window.sessionStorage.setItem("referral_session", code); } catch {}
};
