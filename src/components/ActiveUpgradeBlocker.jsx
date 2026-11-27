import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatCheckoutAmount, normalizeCurrencyCode } from "../lib/checkoutCodes";
import { allocatePaymentSessionSeq, fetchPaymentJson, isAffirmativeTerminalRelease, releasePaymentSessionLock } from "../lib/paymentSessionLocks";
import { markReservationTerminal, reservationScopeKey } from "../lib/reservationScope";

export default function ActiveUpgradeBlocker({
  alreadyTargetInfo,
  blockingUpgradeSession,
  currentScopeKey,
  currentScopeKeyRef,
  packageTitle,
  fetchJson = fetchPaymentJson,
  showBanner,
  onCleared,
  onBooked,
  onUpdated,
}) {
  const [busy, setBusy] = useState(false);
  const blockingIntentKey = `${currentScopeKey}|${blockingUpgradeSession?.paymentAccessToken || ""}|${blockingUpgradeSession?.upgradeIntentId || ""}`;
  const blockingIntentRef = useRef(blockingIntentKey);
  blockingIntentRef.current = blockingIntentKey;

  useEffect(() => {
    setBusy(false);
  }, [blockingIntentKey]);

  const runAction = async (mode) => {
    const token = String(blockingUpgradeSession?.paymentAccessToken || "").trim();
    if (!token || busy) return;
    const capturedIntent = blockingIntentRef.current;
    const capturedScope = currentScopeKeyRef.current;
    const blockScope = reservationScopeKey(blockingUpgradeSession);
    const isRelease = mode === "release";
    const actionSeq = allocatePaymentSessionSeq();
    const stillCurrent = () =>
      blockingIntentRef.current === capturedIntent && currentScopeKeyRef.current === capturedScope;

    setBusy(true);
    try {
      const { response, data } = await fetchJson(
        isRelease ? "/api/payment/cancel" : "/api/payment/status",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
        }
      );
      const status = String(data?.status || "").trim().toLowerCase();
      markReservationTerminal(blockScope, status);
      const affirmative = isAffirmativeTerminalRelease(response.ok, data);
      if (affirmative && (data?.cancelled === true || ["failed", "abandoned", "refunded"].includes(status))) {
        releasePaymentSessionLock({ token, scopeKey: blockScope, seq: actionSeq });
      }
      if (!stillCurrent()) return;
      const doneOk = isRelease ? data?.captured : response.ok;
      if (doneOk && (status === "booked" || status === "email_partial")) {
        onBooked({
          bookingId: data.bookingId || "",
          packageTitle: blockingUpgradeSession.packageTitle || packageTitle,
        });
        return;
      }
      if (isRelease) {
        if (!response.ok || data?.cancelled !== true || !affirmative) {
          throw new Error(data?.error || data?.recoveryReason || "Unable to release active upgrade.");
        }
        onCleared("Previous upgrade session released. You can continue now.");
        return;
      }
      if (!response.ok) throw new Error(data?.error || "Unable to check active upgrade.");
      if (["failed", "abandoned", "refunded"].includes(status) && affirmative) {
        onCleared("The previous upgrade session closed. You can continue now.");
        return;
      }
      onUpdated(status);
      showBanner("info", data?.recoveryReason || "The active upgrade is still in progress.", { persistent: true });
    } catch (error) {
      if (!stillCurrent()) return;
      showBanner("error", error?.message || (isRelease ? "Unable to release active upgrade." : "Unable to check active upgrade."), { persistent: true });
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  };

  if (!alreadyTargetInfo && !blockingUpgradeSession) return null;

  const blockQuote = blockingUpgradeSession?.quote || blockingUpgradeSession?.pricingSnapshot || null;
  const blockCurrency = normalizeCurrencyCode(blockQuote?.currency || blockingUpgradeSession?.currency || "USD");
  const blockAmount = Number(blockQuote?.netAmount);
  const formattedPrice = Number.isFinite(blockAmount) && blockAmount > 0
    ? formatCheckoutAmount(blockAmount, blockCurrency)
    : "";

  return (
    <div className="mt-6 space-y-4">
      {alreadyTargetInfo && (
        <div className="rounded-xl bg-canvas shadow-[0_12px_32px_rgba(0,0,0,0.65)]">
          <div role="status" className="rounded-xl border border-info-border bg-info-soft px-5 py-4 text-sm text-info-text">
            <p className="font-semibold">
              This booking already owns {alreadyTargetInfo.packageTitle || packageTitle}.
            </p>
            <p className="mt-1 break-words opacity-90">
              Your paid credit is preserved for higher-tier upgrades.
              {alreadyTargetInfo.bookingId ? ` Reference: ${alreadyTargetInfo.bookingId}.` : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link
                to="/upgrade"
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-info-border bg-surface-input px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-hover"
              >
                Choose another upgrade
              </Link>
            </div>
          </div>
        </div>
      )}
      {blockingUpgradeSession && (
        <div className="rounded-xl bg-canvas shadow-[0_12px_32px_rgba(0,0,0,0.65)]">
          <div role="status" className="rounded-xl border border-warning-border bg-warning-soft px-5 py-4 text-sm text-warning-text">
            <p className="font-semibold">
              Another upgrade checkout is already in progress
              {blockingUpgradeSession.packageTitle ? ` for ${blockingUpgradeSession.packageTitle}` : ""}
              {formattedPrice ? ` (${formattedPrice})` : ""}.
            </p>
            <p className="mt-1 break-words text-ink">
              Check its status or release the previous upgrade session before starting a new one.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction("status")}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-warning-border bg-surface-input px-4 py-2 text-sm font-semibold text-warning-text hover:bg-surface-hover disabled:opacity-60 sm:w-auto"
              >
                {busy ? "Checking..." : "Check active upgrade"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction("release")}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-line-input bg-surface-input px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-hover disabled:opacity-60 sm:w-auto"
              >
                {busy ? "Releasing..." : "Release active upgrade"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
