import { writeBrowserStorage } from "./browserStorage";
import { normalizeCurrencyCode, toMoney, toSubunitsClient } from "./checkoutCodes";
import { extractTokenNonce } from "./checkoutConfirmation";
import {
  areSameLineageScopeKeys, clearStoredPaymentSessionState, extractPaymentLockId,
  isPaymentLockReleased, readStoredPaymentSessionState, writeStoredPaymentSessionState,
} from "./checkoutSessionGuard";
import { areSameLineageNonces, readScopeMap, recordHoldNonceRotation, reservationScopeKey, walkHoldRotations } from "./reservationScope";

const WATERMARK_KEY = "roo_payment_session_watermarks", RELEASED_KEY = "roo_released_payment_locks", ROTATION_KEY = "roo_hold_rotations";
let nextSessionSeq = 0;

export const STORAGE_SAVE_ERROR = "Your browser could not save this payment session. Checkout has stayed here so you can check its status or change payment method. Allow browser storage and try again to open checkout.";
export const STORAGE_SAVE_CHANGE_ONLY_ERROR = "Your browser could not save this payment session. Checkout has stayed here so you can change payment method. Allow browser storage and try again to open checkout.";

export const quoteExceedsAcceptedCeiling = ({ quote, acceptedQuoteTotal, acceptedQuoteCurrency }) => {
  if (!quote || typeof quote !== "object" || acceptedQuoteTotal === null || !acceptedQuoteCurrency) return false;
  const qCur = normalizeCurrencyCode(quote.currency || "USD"), aCur = normalizeCurrencyCode(acceptedQuoteCurrency);
  if (qCur !== aCur) return true;
  const qNet = quote.isFree === true ? 0 : Math.max(0, toMoney(quote.netAmount ?? 0, qCur));
  return qNet > toMoney(acceptedQuoteTotal, aCur);
};

export const fetchPaymentJson = async (url, options = {}, timeoutMs = 15_000) => {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { ...options, signal: controller?.signal || options.signal });
    const data = await response.json().catch((error) => {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      return {};
    });
    return { response, data };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const verifyProviderLaunchPayload = ({ provider, payload, expectedAmount, expectedCurrency }) => {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "Missing provider order details." };
  const cur = normalizeCurrencyCode(expectedCurrency), sub = toSubunitsClient(expectedAmount, cur);
  const pCur = String(payload.currency || "").trim().toUpperCase(), pAmt = Number(payload.amount || 0), orderId = String(payload.orderId || "").trim();
  if (provider === "razorpay") {
    const key = String(payload.key || payload.keyId || "").trim();
    return orderId && key && pCur === cur && Number.isSafeInteger(pAmt) && pAmt === sub ? { ok: true, orderId, key, currency: pCur, amount: pAmt } : { ok: false, reason: "Payment order details did not match the confirmed quote." };
  }
  if (provider === "paypal") return orderId && pCur === cur && Number.isSafeInteger(pAmt) && pAmt === sub ? { ok: true, orderId, currency: pCur, amount: pAmt } : { ok: false, reason: "PayPal order details did not match the confirmed quote." };
  if (provider === "dodo") {
    const u = String(payload.checkoutUrl || "").trim();
    if (!u) return { ok: false, reason: "Checkout is being recovered. Check the payment status shortly." };
    try {
      const parsed = new URL(u, typeof window !== "undefined" ? window.location.origin : "https://www.rooindustries.com");
      const sameOrigin = typeof window !== "undefined" && parsed.origin === window.location.origin;
      const ok = parsed.protocol === "https:" || (parsed.protocol === "http:" && (sameOrigin || ["localhost", "127.0.0.1"].includes(parsed.hostname)));
      return ok ? { ok: true, checkoutUrl: parsed.href, orderId } : { ok: false, reason: "Checkout link is invalid." };
    } catch { return { ok: false, reason: "Checkout link is invalid." }; }
  }
  return { ok: true };
};

const readWatermarks = () => {
  if (typeof window === "undefined") return { byScope: {}, byLock: {} };
  try {
    const p = JSON.parse(sessionStorage.getItem(WATERMARK_KEY) || "null");
    return {
      byScope: p?.byScope && typeof p.byScope === "object" && !Array.isArray(p.byScope) ? { ...p.byScope } : {},
      byLock: p?.byLock && typeof p.byLock === "object" && !Array.isArray(p.byLock) ? { ...p.byLock } : {},
    };
  } catch { return { byScope: {}, byLock: {} }; }
};
const writeWatermarks = (wm) => {
  if (typeof window === "undefined") return;
  try { sessionStorage.setItem(WATERMARK_KEY, JSON.stringify({ byScope: wm.byScope || {}, byLock: wm.byLock || {} })); } catch {}
};

export const allocatePaymentSessionSeq = () => {
  const wm = readWatermarks(), cur = readStoredPaymentSessionState();
  const maxSeen = Math.max(
    nextSessionSeq,
    Number(cur?.sessionSeq || 0),
    ...Object.values(wm.byScope).map((v) => Number(v) || 0),
    ...Object.values(wm.byLock).map((v) => Number(v) || 0)
  );
  nextSessionSeq = maxSeen + 1;
  return nextSessionSeq;
};

export const isAffirmativeTerminalRelease = (responseOk, data = {}) => {
  if (!responseOk) return false;
  const st = String(data?.status || "").trim().toLowerCase();
  if (data?.cancelled === true || st === "failed" || st === "abandoned") {
    return data?.terminalOutcomeComplete === true && data?.cleanupPending !== true && data?.manualReviewRequired !== true;
  }
  if (st === "booked" || st === "email_partial" || st === "refunded") {
    return data?.cleanupPending !== true && data?.manualReviewRequired !== true && data?.terminalOutcomeComplete !== false;
  }
  return false;
};

export const commitPaymentSessionState = (session, { seq = 0, scopeKey = "" } = {}) => {
  if (!session?.paymentAccessToken || !session?.provider || !session?.fingerprint || !session?.providerPayload) return null;
  const lockId = extractPaymentLockId(session.paymentAccessToken);
  if (!lockId || isPaymentLockReleased(session.paymentAccessToken)) return null;
  const wm = readWatermarks(), cur = readStoredPaymentSessionState();
  const sk = String(scopeKey || session.scopeKey || "").trim();
  const seqNum = Number(seq || session.sessionSeq || 0);
  if (seqNum > 0) {
    if ((sk && seqNum < Number(wm.byScope[sk] || 0)) || seqNum < Number(wm.byLock[lockId] || 0)) return null;
    if (cur?.paymentAccessToken && extractPaymentLockId(cur.paymentAccessToken) !== lockId && Number(cur.sessionSeq || 0) >= seqNum) return null;
  }
  const next = { ...session, ...(sk ? { scopeKey: sk } : {}), ...(seqNum > 0 ? { sessionSeq: seqNum } : {}) };
  const wrote = writeStoredPaymentSessionState(next);
  if (wrote && seqNum > 0) {
    if (sk) wm.byScope[sk] = Math.max(Number(wm.byScope[sk] || 0), seqNum);
    wm.byLock[lockId] = Math.max(Number(wm.byLock[lockId] || 0), seqNum);
    writeWatermarks(wm);
  }
  return next;
};

export const releasePaymentSessionLock = ({ token, scopeKey = "", seq = 0 } = {}) => {
  const lockId = extractPaymentLockId(token);
  if (!lockId || typeof window === "undefined") return false;
  const released = readScopeMap(RELEASED_KEY);
  released[lockId] = true;
  try { sessionStorage.setItem(RELEASED_KEY, JSON.stringify(released)); } catch {}
  const wm = readWatermarks(), seqNum = Number(seq || 0), sk = String(scopeKey || "").trim();
  wm.byLock[lockId] = Math.max(Number(wm.byLock[lockId] || 0), seqNum);
  if (sk) wm.byScope[sk] = Math.max(Number(wm.byScope[sk] || 0), seqNum);
  writeWatermarks(wm);
  const cur = readStoredPaymentSessionState();
  if (cur?.paymentAccessToken && extractPaymentLockId(cur.paymentAccessToken) === lockId) {
    clearStoredPaymentSessionState();
    return true;
  }
  return !cur;
};

export const readLiveSlotHold = () => {
  if (typeof window === "undefined") return null;
  try { const p = JSON.parse(sessionStorage.getItem("my_slot_hold") || "null"); return p && typeof p === "object" ? p : null; } catch { return null; }
};

export const doesLiveHoldMatchLineage = (initialHoldId, initialHoldNonce) => {
  const id = String(initialHoldId || "").trim();
  if (!id) return true;
  const live = readLiveSlotHold();
  if (!live?.holdId || String(live.holdId).trim() !== id) return false;
  const initN = extractTokenNonce(initialHoldNonce), liveN = extractTokenNonce(live.holdToken);
  if (!initN) return true;
  return Boolean(liveN && (liveN === initN || areSameLineageNonces(id, initN, liveN)));
};

export const canWriteRefreshedHold = (refreshedHold, initialHoldId, initialHoldNonce) => {
  const targetId = String(refreshedHold?.slotHoldId || "").trim(), targetN = extractTokenNonce(refreshedHold?.slotHoldToken);
  if (!targetId || !String(refreshedHold?.slotHoldToken || "").trim()) return false;
  if (initialHoldId && !doesLiveHoldMatchLineage(initialHoldId, initialHoldNonce)) return false;
  const live = readLiveSlotHold();
  if (!live?.holdId) return !initialHoldId;
  if (String(live.holdId).trim() !== targetId) return false;
  const liveN = extractTokenNonce(live.holdToken);
  if (liveN && targetN && targetN !== liveN && walkHoldRotations(targetId, targetN, readScopeMap(ROTATION_KEY), (n) => n === liveN)) return false;
  return !liveN || !targetN || liveN === targetN || areSameLineageNonces(targetId, liveN, targetN) || Boolean(initialHoldId);
};

export const persistDetachedStartResult = ({ booking, data, provider, fingerprint, scopeKey, seq, initialHoldId, initialHoldNonce, readStoredCheckout, writeStoredCheckout }) => {
  if (!data?.paymentAccessToken || provider === "free") return null;
  const latestCheckout = readStoredCheckout ? readStoredCheckout() : null;
  const latestScope = latestCheckout ? reservationScopeKey(latestCheckout) : "";
  if (latestScope && scopeKey && !areSameLineageScopeKeys(latestScope, scopeKey)) return null;
  const refreshedHold = data.refreshedHold || data.hold || null;
  if (!booking?.originalOrderId) {
    if (initialHoldId && !doesLiveHoldMatchLineage(initialHoldId, initialHoldNonce)) return null;
    if (!initialHoldId && refreshedHold?.slotHoldId && !canWriteRefreshedHold(refreshedHold, "", "")) return null;
  }
  const nextSession = {
    provider, fingerprint, scopeKey,
    paymentAccessToken: String(data.paymentAccessToken || "").trim(),
    providerPayload: data.providerPayload || {},
    providerOrderReady: data.providerOrderReady !== false,
    sessionExpiresAt: String(data.sessionExpiresAt || "").trim(),
    result: data,
  };
  const committed = commitPaymentSessionState(nextSession, { seq, scopeKey });
  if (!committed) return null;
  if (refreshedHold?.slotHoldId && refreshedHold?.slotHoldToken && canWriteRefreshedHold(refreshedHold, initialHoldId, initialHoldNonce)) {
    recordHoldNonceRotation({ slotHoldId: refreshedHold.slotHoldId, fromNonce: initialHoldNonce || booking?.slotHoldToken || "", toNonce: refreshedHold.slotHoldToken });
    const expiresAt = refreshedHold.slotHoldExpiresAt || refreshedHold.expiresAt || "";
    if (latestCheckout && writeStoredCheckout && areSameLineageScopeKeys(latestScope, scopeKey)) {
      writeStoredCheckout({ ...latestCheckout, slotHoldId: refreshedHold.slotHoldId, slotHoldToken: refreshedHold.slotHoldToken, slotHoldExpiresAt: expiresAt });
    }
    try {
      const holdState = {
        holdId: refreshedHold.slotHoldId, holdToken: refreshedHold.slotHoldToken, expiresAt,
        startTimeUTC: booking?.startTimeUTC || "", packageTitle: booking?.packageTitle || "",
        phase: refreshedHold.phase || "payment_pending",
      };
      writeBrowserStorage("sessionStorage", "my_slot_hold", JSON.stringify(holdState));
      window.dispatchEvent(new CustomEvent("hold-state", { detail: holdState }));
    } catch {}
  }
  return committed;
};
