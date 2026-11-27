import { writeBrowserStorage } from "./browserStorage";
import { announceCheckoutConfirmationChange, extractTokenNonce } from "./checkoutConfirmation";
import { areSameLineageNonces, readScopeMap, reservationScopeKey, walkHoldRotations } from "./reservationScope";

const TERMINAL_KEY = "roo_terminal_reservations", ROTATION_KEY = "roo_hold_rotations";
const PENDING_KEY = "roo_pending_payment_starts", SESSION_KEY = "payment_session_state", QUOTE_PROVIDER_KEY = "roo_selected_quote_provider";
const NON_RESUMABLE = ["needs_recovery", "finalizing", "captured_client", "captured_webhook"];
const str = (v) => String(v || "").trim();
const dropDodoQuery = (p) => { const h = p.has("dodo_return") || p.has("dodo_cancel") || p.has("dodo_session"); p.delete("dodo_return"); p.delete("dodo_cancel"); p.delete("dodo_session"); return h; };
export const syncHistoryCheckoutBooking = (bookingData) => { try { const s = typeof window !== "undefined" ? window.history?.state : null; if (s?.usr?.bookingData) window.history.replaceState({ ...s, usr: { ...s.usr, bookingData } }, ""); } catch {} };
export const syncCheckoutRef = (ref, data, ready) => {
  const cur = ref.current;
  if (!ready) return;
  if (!cur || data.slotHoldId !== cur.slotHoldId || data.originalOrderId !== cur.originalOrderId) { ref.current = data; return; }
  const from = extractTokenNonce(data.slotHoldToken), to = extractTokenNonce(cur.slotHoldToken);
  if (!(cur.slotHoldId && from && to && from !== to && walkHoldRotations(cur.slotHoldId, from, readScopeMap(ROTATION_KEY), (n) => n === to))) ref.current = data;
};
export const stripDodoReturnFromHistory = () => { try { const u = typeof window !== "undefined" ? new URL(window.location.href) : null; if (u && dropDodoQuery(u.searchParams)) window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`); } catch {} };
export const isNonResumablePaymentData = (d) => d?.manualReviewRequired === true || d?.captured === true || NON_RESUMABLE.includes(str(d?.status).toLowerCase());
export const ownsSessionHold = (session, { checkoutRef, readStoredCheckout, sessionHold, bookingData }) => {
  const token = str(session?.result?.refreshedHold?.slotHoldToken || session?.result?.hold?.slotHoldToken);
  if (!token) return true;
  let storedToken = "";
  try { storedToken = JSON.parse(sessionStorage.getItem("my_slot_hold") || "null")?.holdToken; } catch {}
  const current = [storedToken, readStoredCheckout()?.slotHoldToken, checkoutRef.current?.slotHoldToken, sessionHold?.slotHoldToken, bookingData?.slotHoldToken].map(str).find(Boolean) || "";
  return !current || current === token;
};
export const clearDodoNavQuery = ({ dodoReturnHandled, latestNavRef, navigate, nextCheckout = null, force = false }) => {
  if (dodoReturnHandled) dodoReturnHandled.current = "";
  const loc = latestNavRef?.current?.location, query = loc ? new URLSearchParams(loc.search) : null;
  if (!query || (!dropDodoQuery(query) && !force)) return;
  navigate({ pathname: loc.pathname, search: query.toString(), hash: loc.hash }, { replace: true, state: nextCheckout ? { ...latestNavRef.current.navState, bookingData: nextCheckout } : loc.state });
};

export const parseCheckoutFingerprint = (v) => { try { const p = JSON.parse(String(v || "")); return p && typeof p === "object" && !Array.isArray(p) ? p : null; } catch { return null; } };
export const paymentSessionMatchesCheckout = (a, b) => a === b || (() => { const s = parseCheckoutFingerprint(a), c = parseCheckoutFingerprint(b); return Boolean(s && c && ["packageTitle", "originalOrderId", "startTimeUTC", "email"].every((k) => String(s[k] || "") === String(c[k] || ""))); })();
export const readStoredPaymentSessionState = () => { try { const p = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); return p?.paymentAccessToken && p?.provider && p?.fingerprint && p?.providerPayload ? p : null; } catch { return null; } };
export const writeStoredPaymentSessionState = (s) => s?.paymentAccessToken && s?.provider && s?.fingerprint && s?.providerPayload ? writeBrowserStorage("sessionStorage", SESSION_KEY, JSON.stringify(s)) : false;
export const clearStoredPaymentSessionState = () => { try { sessionStorage.removeItem(SESSION_KEY); } catch {} };
export const readScopedQuoteProvider = (k) => { if (!k || typeof window === "undefined") return ""; try { const p = JSON.parse(sessionStorage.getItem(QUOTE_PROVIDER_KEY) || "null"); return p?.scopeKey === k ? String(p.provider || "").trim().toLowerCase() : ""; } catch { return ""; } };
export const writeScopedQuoteProvider = (k, provider) => {
  if (typeof window === "undefined") return;
  const p = String(provider || "").trim().toLowerCase();
  try { if (!k || !p) sessionStorage.removeItem(QUOTE_PROVIDER_KEY); else sessionStorage.setItem(QUOTE_PROVIDER_KEY, JSON.stringify({ scopeKey: k, provider: p })); } catch {}
};

export const isReservationTerminal = (k) => {
  if (!k || typeof window === "undefined") return false;
  const term = readScopeMap(TERMINAL_KEY);
  if (term[k]) return true;
  try { const p = JSON.parse(k); return p?.k === "b" && Boolean(p.h && p.n) && walkHoldRotations(p.h, p.n, readScopeMap(ROTATION_KEY), (n) => Boolean(term[JSON.stringify({ ...p, n })])); } catch { return false; }
};
export const areSameLineageScopeKeys = (ka, kb) => {
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  try { const pa = JSON.parse(ka), pb = JSON.parse(kb); return pa.k === "b" && pb.k === "b" && pa.h === pb.h && pa.p === pb.p && pa.t === pb.t && pa.e === pb.e && areSameLineageNonces(pa.h, pa.n, pb.n); } catch { return false; }
};
export const selectPaymentBookingData = (nav, stored, clearStored) => {
  const navC = nav && !isReservationTerminal(reservationScopeKey(nav)) ? nav : null;
  const termS = stored && isReservationTerminal(reservationScopeKey(stored));
  if (termS) clearStored();
  const storedC = stored && !termS ? stored : null;
  return (navC && storedC ? (areSameLineageScopeKeys(reservationScopeKey(navC), reservationScopeKey(storedC)) ? storedC : navC) : navC || storedC) || {};
};
export const paymentSessionMatchesBookingLineage = (session, booking) => {
  if (!session || !booking) return false;
  const vs = reservationScopeKey(booking);
  if (session.scopeKey && vs) return areSameLineageScopeKeys(session.scopeKey, vs);
  if (booking.originalOrderId) return true;
  const r = session.result?.refreshedHold || session.result?.hold;
  if (!r?.slotHoldId) return true;
  const vh = String(booking.slotHoldId || "").trim(), vt = String(booking.slotHoldToken || "").trim();
  return Boolean(vh && String(r.slotHoldId).trim() === vh && (!vt || !r.slotHoldToken || areSameLineageNonces(vh, r.slotHoldToken, vt)));
};

export const validateDodoCallback = ({ query, session, visibleBooking, visibleFingerprint }) => {
  const isCancel = query.has("dodo_cancel"), isReturn = query.has("dodo_return");
  if (!isCancel && !isReturn) return { action: "none" };
  if (session?.provider !== "dodo" || !session?.paymentAccessToken || !paymentSessionMatchesCheckout(session.fingerprint, visibleFingerprint) || !paymentSessionMatchesBookingLineage(session, visibleBooking)) return { action: "ignore" };
  const urlTag = String(query.get("dodo_session") || "").trim(), storedTag = String(session.providerPayload?.dodoReturnTag || session.dodoReturnTag || "").trim();
  if (isCancel) return urlTag && storedTag && urlTag === storedTag ? { action: "cancel" } : { action: "ignore" };
  return storedTag ? (urlTag && urlTag === storedTag ? { action: "finalize" } : { action: "ignore" }) : (urlTag ? { action: "ignore" } : { action: "status" });
};

const syncPendingStarts = () => {
  if (typeof window === "undefined") return;
  const now = Date.now(), active = Object.fromEntries(Object.entries(window.__rooPendingStarts || {}).filter(([, e]) => e.until > now));
  window.__rooPendingStarts = active;
  try { if (Object.keys(active).length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(active)); else sessionStorage.removeItem(PENDING_KEY); } catch {}
};
export const beginPendingPaymentStart = (holdId, holdToken) => {
  if (typeof window === "undefined") return "";
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  window.__rooPendingStarts = { ...readScopeMap(PENDING_KEY), ...(window.__rooPendingStarts || {}), [id]: { holdId: String(holdId || "").trim(), nonce: extractTokenNonce(holdToken), until: Date.now() + 45_000 } };
  syncPendingStarts(); announceCheckoutConfirmationChange(); return id;
};
export const endPendingPaymentStart = (id) => {
  if (!id || typeof window === "undefined") return;
  if (window.__rooPendingStarts) delete window.__rooPendingStarts[id];
  syncPendingStarts(); announceCheckoutConfirmationChange();
};
export const mergeLineageCheckout = (latest, current, patch = {}) => ({ ...(latest && areSameLineageScopeKeys(reservationScopeKey(latest), reservationScopeKey(current)) ? latest : current), ...patch });
