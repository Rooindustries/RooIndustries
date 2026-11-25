import crypto from "crypto";
import { issueHoldToken } from "../../booking/holdToken.js";
import { HOLD_PHASE_HOLDING, PAYMENT_STATUS_ABANDONED, PAYMENT_STATUS_STARTED, PAYMENT_START_CLAIM_TYPE, PAYMENT_UPGRADE_LOCK_TYPE, buildPaymentRecordEvent, mergePaymentRecordEvents } from "./paymentRecord.js";

const err = (httpStatus, error) => ({ httpStatus, body: { ok: false, error } });

export const commitAtomicDodoRequiresPaymentMethodCancel = async ({
  client, record, inspectedRev, inspection, getHoldById, getPaymentRecordById, getDocumentById,
  loadCouponReservationHandlers, prepareCouponRelease, appendCouponRelease,
  isFutureIso, lateCaptureWatchUntil, nextRecoveryAt, now, hasKnownCapture, isConflictError, buildPublicStatusBody,
}) => {
  const loaded = record.couponReservationId ? await loadCouponReservationHandlers() : {};
  const prepareCoupon = prepareCouponRelease || loaded.prepareCouponRelease, appendCoupon = appendCouponRelease || loaded.appendCouponRelease;
  if (record.couponReservationId && (typeof prepareCoupon !== "function" || typeof appendCoupon !== "function")) return err(503, "Coupon release is temporarily unavailable.");
  const fresh = (await getPaymentRecordById(client, record._id)) || record;
  if (!inspectedRev || fresh?._rev !== inspectedRev || String(fresh?.status || "").trim().toLowerCase() !== PAYMENT_STATUS_STARTED || hasKnownCapture(fresh)) return err(409, "Payment state changed before it could be released.");
  const holdId = String(fresh?.bookingPayload?.slotHoldId || "").trim(), hold = holdId ? await getHoldById(client, holdId) : null;
  if (holdId && (!hold?._id || !hold._rev || String(hold.paymentRecordId || "").trim() !== String(fresh._id).trim())) return err(409, "The slot reservation is no longer owned by this payment.");
  const expiresAt = String(hold?.expiresAt || "").trim(), holdExpired = Boolean(holdId && hold?._id && !isFutureIso(expiresAt));
  const holdNonce = holdId && hold?._id && !holdExpired ? crypto.randomUUID() : "";
  const refreshedHold = holdNonce ? { slotHoldId: holdId, slotHoldToken: issueHoldToken({ holdId, startTimeUTC: hold.startTimeUTC, expiresAt, holdNonce, backend: fresh.backendOwner, cutoverGeneration: Number(fresh.cutoverGeneration || 0) }), slotHoldExpiresAt: expiresAt, phase: HOLD_PHASE_HOLDING } : null;
  const reason = holdExpired ? "customer_cancelled_expired_payment" : "customer_changed_payment_method";
  const couponPlan = fresh.couponReservationId ? await prepareCoupon({ client, redemptionId: fresh.couponReservationId }) : null;
  if (fresh.couponReservationId) {
    if (!couponPlan?.redemption?._id) return err(503, "Coupon release is temporarily unavailable.");
    if (["consumed", "refunded"].includes(String(couponPlan.redemption.status || "").trim().toLowerCase())) return err(409, "Payment state changed before it could be released.");
  }
  const claimId = String(fresh.startClaimId || "").trim();
  const claim = claimId ? await getDocumentById({ client, id: claimId, type: claimId.startsWith("paymentUpgradeLock.") ? PAYMENT_UPGRADE_LOCK_TYPE : PAYMENT_START_CLAIM_TYPE }) : null;
  if (claim?._id && (!claim._rev || String(claim.paymentRecordId || "").trim() !== String(fresh._id).trim())) return err(409, "Payment claim ownership changed before cancellation.");
  const nextSet = {
    status: PAYMENT_STATUS_ABANDONED, providerPaymentState: "cancelled", ...(inspection?.providerPaymentId ? { providerPaymentId: inspection.providerPaymentId } : {}),
    recoveryReason: reason, resourceReleasePending: false, resourceReleaseTargetStatus: "", resourceReleaseReason: "", recoveryFailureCount: 0,
    reconciliationRecoveryTerminal: false, lateCaptureWatchUntil, nextRecoveryAt, cancelledHoldSnapshot: refreshedHold || {}, updatedAt: now,
    events: mergePaymentRecordEvents(fresh.events, buildPaymentRecordEvent({ status: PAYMENT_STATUS_ABANDONED, source: "client", reason })),
  };
  let tx = client.transaction().patch(fresh._id, (patch) => patch.ifRevisionId(inspectedRev).set(nextSet));
  if (holdId && hold?._id) tx = holdExpired ? tx.delete(hold._id, { ifRevisionId: hold._rev }) : tx.patch(hold._id, (patch) => patch.ifRevisionId(hold._rev).set({ phase: HOLD_PHASE_HOLDING, holdNonce, paymentRecordId: "", paymentProvider: "", expiresAt }));
  if (couponPlan?.redemption?._id) tx = appendCoupon({ transaction: tx, prepared: couponPlan, reason, releasedAt: now });
  if (claim?._id) tx = tx.delete(claim._id, { ifRevisionId: claim._rev });
  try { await tx.commit(); } catch (error) { if (isConflictError(error)) return err(409, "Payment state changed before it could be released."); throw error; }
  return { httpStatus: 200, body: { ...buildPublicStatusBody({ ...fresh, ...nextSet }), ok: true, cancelled: true, ...(holdExpired ? { slotReleased: true } : {}), ...(refreshedHold ? { refreshedHold } : {}) } };
};
