import { extractTokenNonce } from "./checkoutConfirmation";

const TERMINAL_KEY = "roo_terminal_reservations", ROTATION_KEY = "roo_hold_rotations";
const TERMINAL_STATUSES = new Set(["booked", "email_partial", "refunded"]);

export const readScopeMap = (key) => { try { const p = JSON.parse(sessionStorage.getItem(key) || "null"); return p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch { return {}; } };
export const walkHoldRotations = (holdId, start, rot, visit) => {
  if (!holdId || !start) return false;
  const seen = new Set([start]);
  for (let cur = start; rot[`${holdId}:${cur}`]; ) {
    const next = rot[`${holdId}:${cur}`];
    if (visit(next)) return true;
    if (seen.has(next)) break;
    seen.add(next); cur = next;
  }
  return false;
};
export const areSameLineageNonces = (holdId, a, b) => {
  const na = extractTokenNonce(a), nb = extractTokenNonce(b);
  if (!holdId || !na || !nb) return false;
  if (na === nb) return true;
  const rot = readScopeMap(ROTATION_KEY);
  return walkHoldRotations(holdId, na, rot, (n) => n === nb) || walkHoldRotations(holdId, nb, rot, (n) => n === na);
};
export const reservationScopeKey = (b = {}) => {
  if (!b || typeof b !== "object") return "";
  const o = String(b.originalOrderId || "").trim(), p = String(b.packageTitle || "").trim(), e = String(b.email || "").trim().toLowerCase();
  if (o) return JSON.stringify({ k: "u", o, i: extractTokenNonce(b.upgradeIntentToken || b.upgradeIntentId || ""), p, e });
  const h = String(b.slotHoldId || b.holdId || "").trim(), t = String(b.startTimeUTC || "").trim();
  return !h && !t ? "" : JSON.stringify({ k: "b", h, n: extractTokenNonce(b.slotHoldToken || b.holdToken || ""), p, t, e });
};
export const recordHoldNonceRotation = ({ slotHoldId, fromNonce, toNonce } = {}) => {
  const holdId = String(slotHoldId || "").trim(), from = extractTokenNonce(fromNonce), to = extractTokenNonce(toNonce);
  if (!holdId || !from || !to || from === to || typeof window === "undefined") return;
  const rot = readScopeMap(ROTATION_KEY); rot[`${holdId}:${from}`] = to;
  try { sessionStorage.setItem(ROTATION_KEY, JSON.stringify(rot)); } catch {}
};
export const markReservationTerminal = (scopeKey, status) => {
  const st = String(status || "").trim().toLowerCase();
  if (!scopeKey || !TERMINAL_STATUSES.has(st) || typeof window === "undefined") return false;
  const map = readScopeMap(TERMINAL_KEY); map[scopeKey] = st;
  try { sessionStorage.setItem(TERMINAL_KEY, JSON.stringify(map)); } catch {}
  return true;
};
