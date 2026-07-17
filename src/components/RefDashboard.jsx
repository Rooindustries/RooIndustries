import React, { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import packageContent from "../lib/packageContent";
import ConnectedAccounts from "./ConnectedAccounts";

const { normalizePackageText } = packageContent;

const resolveAuthNotice = (search) => {
  const query = new URLSearchParams(search);
  if (
    query.get("linked") === "discord" ||
    query.get("notice") === "discord-linked"
  ) {
    return { type: "success", message: "Discord linked to your account." };
  }
  if (query.get("notice") === "discord-link-failed") {
    return {
      type: "error",
      message: "Discord linking did not complete. Try the Discord login again.",
    };
  }
  return null;
};

export default function RefDashboard() {
  const nav = useNavigate();
  const location = useLocation();

  const [creator, setCreator] = useState(null);
  const [commission, setCommission] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [max, setMax] = useState(0);
  const [payout, setPayout] = useState(null);
  const [payoutLoading, setPayoutLoading] = useState(true);
  const [payoutError, setPayoutError] = useState(null);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [closingLogsModal, setClosingLogsModal] = useState(false);
  const [logsModalAnimatingIn, setLogsModalAnimatingIn] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [toast, setToast] = useState(null);
  const [authNotice] = useState(() => resolveAuthNotice(location.search));
  const noScrollbarStyles = `
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  `;

  useEffect(() => {
    const loadPayouts = async () => {
      try {
        setPayoutLoading(true);
        setPayoutError(null);
        const res = await fetch("/api/ref/payouts");
        const data = await res.json();

        if (!data.ok) {
          setPayout(null);
          setPayoutError(data.error || "Could not load payout data.");
          return;
        }

        setPayout(data);
      } catch {
        console.error("Referral payout loading failed");
        setPayout(null);
        setPayoutError("Could not load payout data.");
      } finally {
        setPayoutLoading(false);
      }
    };

    async function load() {
      try {
        const res = await fetch("/api/ref/getData");
        const data = await res.json();

        if (!data.ok) {
          try {
            sessionStorage.removeItem("creatorId");
          } catch {
            console.error("Failed to clear obsolete referral state");
          }
          return nav("/referrals/login");
        }

        const ref = data.referral || {};

        const successfulReferrals = ref.successfulReferrals ?? 0;

        const normalized = {
          ...ref,
          successfulReferrals,
        };

        setCreator(normalized);
        setMax(normalized.maxCommissionPercent ?? 15);
        loadPayouts();

        const bypass = normalized.bypassUnlock === true;
        const isUnlocked = successfulReferrals >= 5 || bypass;

        if (!isUnlocked) {
          setCommission(10);
          setDiscount(0);
        } else {
          setCommission(normalized.currentCommissionPercent ?? 10);
          setDiscount(normalized.currentDiscountPercent ?? 0);
        }
      } catch {
        console.error("Referral dashboard loading failed");
        try {
          sessionStorage.removeItem("creatorId");
        } catch {
          console.error("Failed to clear obsolete referral state");
        }
        nav("/referrals/login");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [nav]);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  }

  const toMoneyNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const formatCurrency = (value) => `$${toMoneyNumber(value).toFixed(2)}`;

  const formatDate = (value) => {
    if (!value) return "--";
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const StatCard = ({
    label,
    value,
    accent = "text-accent",
    className = "",
  }) => (
    <div className={`${cardClass} ${className}`}>
      <p className="text-[14px] uppercase text-ink-muted tracking-wide">
        {label}
      </p>
      <p className={`text-[30px] font-extrabold ${accent}`}>
        {formatCurrency(value)}
      </p>
    </div>
  );

  const BalanceCard = ({ label, earned, paid, owed, overpaid }) => (
    <div className={cardClass}>
      <div>
        <p className="text-[14px] uppercase text-ink-muted tracking-wide">
          {label}
        </p>
        <p className="text-lg font-bold text-ink">Balance</p>
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-ink-muted">Earned</span>
          <span className="font-semibold text-info-text">
            {formatCurrency(earned)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-ink-muted">Paid</span>
          <span className="font-semibold text-success-text">
            {formatCurrency(paid)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-ink-muted">Owed</span>
          <span
            className={`font-semibold ${
              toMoneyNumber(owed) > 0 ? "text-warning-text" : "text-success-text"
            }`}
          >
            {formatCurrency(owed)}
          </span>
        </div>
        {toMoneyNumber(overpaid) > 0 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-muted">Overpaid</span>
            <span className="font-semibold text-fuchsia-300">
              {formatCurrency(overpaid)}
            </span>
          </div>
        )}
      </div>
    </div>
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (showLogsModal) {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    } else {
      document.body.style.overflow = previousOverflow || "";
      document.documentElement.style.overflow = previousOverflow || "";
    }
    return () => {
      document.body.style.overflow = previousOverflow || "";
      document.documentElement.style.overflow = previousOverflow || "";
    };
  }, [showLogsModal]);

  const closeLogsModal = useCallback(() => {
    setClosingLogsModal(true);
    setTimeout(() => {
      setShowLogsModal(false);
      setClosingLogsModal(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!showLogsModal) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeLogsModal();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeLogsModal, showLogsModal]);

  useEffect(() => {
    if (showLogsModal) {
      setLogsModalAnimatingIn(false);
      requestAnimationFrame(() => setLogsModalAnimatingIn(true));
    } else {
      setLogsModalAnimatingIn(false);
    }
  }, [showLogsModal]);

  const unlocked =
    (creator?.successfulReferrals || 0) >= 5 || creator?.bypassUnlock === true;

  const total = commission + discount;
  const invalid = total > max;
  const panelClass =
    "bg-panel p-6 rounded-2xl border border-line-input shadow-glow-soft backdrop-blur-md";
  const cardClass =
    "bg-surface-input border border-line-input rounded-xl p-4 h-full flex flex-col justify-between";

  function adjustCommission(delta) {
    if (!unlocked) return;
    const newVal = commission + delta;
    if (newVal < 0) return;
    if (newVal + discount > max) return;
    setCommission(newVal);
  }

  function adjustDiscount(delta) {
    if (!unlocked) return;
    const newVal = discount + delta;
    if (newVal < 0) return;
    if (newVal + commission > max) return;
    setDiscount(newVal);
  }

  async function save() {
    if (invalid || !unlocked) return;

    setSaving(true);

    try {
      const res = await fetch("/api/ref/updateSplit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commissionPercent: commission,
          discountPercent: discount,
        }),
      });

      const result = await res.json();
      if (!result.ok) showToast("error", result.error || "Failed to save");
      else showToast("success", "Saved successfully!");
    } catch {
      console.error("Referral settings save failed");
      showToast("error", "Server error");
    }
    setSaving(false);
  }

  if (loading)
    return <p className="text-center text-ink pt-32">Loading...</p>;
  if (!creator) return null;

  const currentRefs = creator.successfulReferrals ?? 0;
  const refsLeft = Math.max(0, 5 - currentRefs);

  const referralCode = creator.slug?.current || "";
  const referralOrigin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://www.rooindustries.com";
  const referralLink = `${referralOrigin}/?ref=${encodeURIComponent(
    referralCode
  )}`;

  const payoutData = payout || {};
  const earnings = payoutData.earnings || {};
  const payments = payoutData.payments || {};
  const remaining = payoutData.remaining || {};
  const owedRaw = payoutData.owed || {};
  const overpaidRaw = payoutData.overpaid || {};
  const positiveMoney = (value) => Math.max(0, toMoneyNumber(value));
  const owed = {
    xoc: positiveMoney(owedRaw.xoc ?? remaining.xoc),
    vertex: positiveMoney(owedRaw.vertex ?? remaining.vertex),
    total: positiveMoney(owedRaw.total ?? remaining.total),
  };
  const overpaid = {
    xoc: positiveMoney(overpaidRaw.xoc ?? -toMoneyNumber(remaining.xoc)),
    vertex: positiveMoney(
      overpaidRaw.vertex ?? -toMoneyNumber(remaining.vertex)
    ),
    total: positiveMoney(overpaidRaw.total ?? -toMoneyNumber(remaining.total)),
  };
  const payoutBuckets = [
    {
      key: "xoc",
      label: "Vertex Max",
      earned: earnings.xoc,
      paid: payments.xoc,
      owed: owed.xoc,
      overpaid: overpaid.xoc,
    },
    {
      key: "vertex",
      label: "Vertex",
      earned: earnings.vertex,
      paid: payments.vertex,
      owed: owed.vertex,
      overpaid: overpaid.vertex,
    },
  ];
  const logs = payoutData.logs || {};
  const packageBreakdownRaw = Array.isArray(payoutData.packageBreakdown)
    ? payoutData.packageBreakdown
    : [];
  const fallbackBreakdown = earnings.byPackage
    ? Object.keys(earnings.byPackage)
        .sort((a, b) => a.localeCompare(b))
        .map((title) => ({
          title: normalizePackageText(title),
          amount: earnings.byPackage[title],
        }))
    : [];
  const packageBreakdown =
    packageBreakdownRaw.length > 0
      ? packageBreakdownRaw.map((item) => ({
          ...item,
          title: normalizePackageText(item.title),
        }))
      : fallbackBreakdown;

  async function copyReferralLink() {
    try {
      await navigator.clipboard.writeText(referralLink);
      showToast("success", "Referral link copied!");
    } catch {
      console.error("Referral link copy failed");
      showToast("error", "Failed to copy link");
    }
  }

  return (
    <>
      <style>{noScrollbarStyles}</style>
      <section className="pt-28 px-6 max-w-xl mx-auto text-ink mb-20">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow">
        Welcome, {creator.name}
      </h1>

      {authNotice ? (
        <div
          aria-live="polite"
          className={`mt-6 rounded-xl border px-4 py-3 text-sm font-semibold ${
            authNotice.type === "success"
              ? "border-success-border bg-success-soft text-success-text"
              : "border-danger-border bg-danger-soft text-danger-text"
          }`}
          role={authNotice.type === "error" ? "alert" : "status"}
        >
          {authNotice.message}
        </div>
      ) : null}

      <p className="mt-1 text-center opacity-70">
        Referral Code: <b className="text-accent">{referralCode}</b>
      </p>


      <div className={`mt-8 ${panelClass} space-y-2`}>
        <p className="text-sm font-semibold text-info-text mb-2">
          Your referral link
        </p>

        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <input
            type="text"
            value={referralLink}
            readOnly
            className="flex-1 bg-surface-input border border-line-input rounded-md px-3 py-2 text-xs sm:text-sm text-ink truncate"
          />

          <button
            onClick={copyReferralLink}
            className="px-4 py-2 bg-accent-strong hover:bg-accent text-accent-contrast rounded-md text-xs sm:text-sm font-semibold"
          >
            Copy
          </button>
        </div>

        <p className="mt-2 text-[11px] text-ink-muted">
          Share this link with your viewers. Anyone who books through it will
          use your code.
        </p>
      </div>

      <div className={`mt-12 ${panelClass} space-y-8`}>

        <div className="bg-surface-input border border-line-input rounded-xl px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase text-ink-muted tracking-wide">
              Total successful referrals
            </p>
            <p className="text-2xl font-extrabold text-accent">
              {currentRefs}
            </p>
          </div>
          <div className="text-right text-xs text-ink-muted">
            {unlocked ? (
              <p className="text-success-text font-semibold">
                Perks unlocked 🎉
                <br />
                You can now adjust commission &amp; discount.
              </p>
            ) : (
              <p>
                {refsLeft} more referral{refsLeft === 1 ? "" : "s"} to unlock
                full control.
              </p>
            )}
          </div>
        </div>


        <div
          className={`space-y-2 ${
            !unlocked ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <p className="text-accent font-semibold">Commission (%)</p>
          <div className="flex items-center justify-between bg-surface-input p-3 rounded-xl border border-line-input">
            <button
              onClick={() => adjustCommission(-1)}
              className="px-4 py-2 bg-surface-hover-accent hover:bg-info-soft rounded-xl text-xl font-bold transition"
            >
              –
            </button>
            <span className="text-xl font-bold">{commission}%</span>
            <button
              onClick={() => adjustCommission(1)}
              className="px-4 py-2 bg-surface-hover-accent hover:bg-info-soft rounded-xl text-xl font-bold transition"
            >
              +
            </button>
          </div>
        </div>


        <div
          className={`space-y-2 ${
            !unlocked ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <p className="text-accent font-semibold">Viewer Discount (%)</p>
          <div className="flex items-center justify-between bg-surface-input p-3 rounded-xl border border-line-input">
            <button
              onClick={() => adjustDiscount(-1)}
              className="px-4 py-2 bg-surface-hover-accent hover:bg-info-soft rounded-xl text-xl font-bold transition"
            >
              –
            </button>
            <span className="text-xl font-bold">{discount}%</span>
            <button
              onClick={() => adjustDiscount(1)}
              className="px-4 py-2 bg-surface-hover-accent hover:bg-info-soft rounded-xl text-xl font-bold transition"
            >
              +
            </button>
          </div>
        </div>


        <div
          className={`text-center font-semibold text-lg ${
            invalid ? "text-danger-text" : "text-success-text"
          }`}
        >
          Total: {total}% / Max {max}%
        </div>


        <button
          onClick={save}
          disabled={invalid || saving || !unlocked}
          className={`w-full py-3 rounded-xl font-bold transition-all ${
            invalid || !unlocked
              ? "bg-surface-input cursor-not-allowed opacity-40"
              : "bg-accent-strong hover:bg-accent text-accent-contrast shadow-glow-soft"
          }`}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>


      <div className={`mt-10 ${panelClass} space-y-4`}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-muted">
              Payouts
            </p>
            <h3 className="text-lg sm:text-xl font-bold text-ink">
              Earnings &amp; Payments
            </h3>
            <p className="text-xs text-ink-muted">
              Calculated from your referral sales.
            </p>
          </div>
          <span className="text-xs text-ink-muted">
            {payoutLoading ? "Updating..." : "Auto-updated"}
          </span>
        </div>

        {payoutError && (
          <div className="bg-danger-soft border border-danger-border text-danger-text text-sm rounded-xl px-3 py-2">
            {payoutError}
          </div>
        )}

        {!payout && payoutLoading && (
          <p className="text-sm text-ink-muted">Loading payout data...</p>
        )}

        {payout && (
          <>
            <div className="grid sm:grid-cols-3 gap-3 auto-rows-fr">
              <StatCard label="Total earned" value={earnings.total} />
              <StatCard
                label="Total paid"
                value={payments.total}
                accent="text-success-text"
              />
              <StatCard
                label="Remaining owed"
                value={owed.total}
                accent={owed.total > 0 ? "text-warning-text" : "text-success-text"}
              />
            </div>

            {overpaid.total > 0 && (
              <div className="bg-fuchsia-500/10 border border-fuchsia-400/40 rounded-xl px-3 py-2 text-sm text-fuchsia-100">
                Paid ahead by {formatCurrency(overpaid.total)}.
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-3 auto-rows-fr">
              {payoutBuckets.map((bucket) => (
                <BalanceCard
                  key={bucket.key}
                  label={bucket.label}
                  earned={bucket.earned}
                  paid={bucket.paid}
                  owed={bucket.owed}
                  overpaid={bucket.overpaid}
                />
              ))}
            </div>

            {packageBreakdown.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-ink-muted">
                  Package earnings
                </p>
                <div className="grid sm:grid-cols-3 gap-3 auto-rows-fr">
                  {packageBreakdown.map((item) => (
                    <StatCard
                      key={`pkg-${item.title}`}
                      label={`Earned - ${item.title}`}
                      value={item.amount}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className={`${cardClass} flex flex-col gap-2`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">
                  Payment Logs
                </p>
                <span className="text-xs text-ink-muted">
                  {(logs.xoc?.length || 0) + (logs.vertex?.length || 0)} entries
                </span>
              </div>
              <p className="text-xs text-ink-muted">
                View your Vertex Max and Vertex payment history.
              </p>
              <button
                onClick={() => setShowLogsModal(true)}
                className="glow-button inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white w-full sm:w-auto"
              >
                View my payment logs
                <span className="glow-line glow-line-top" />
                <span className="glow-line glow-line-right" />
                <span className="glow-line glow-line-bottom" />
                <span className="glow-line glow-line-left" />
              </button>
            </div>

          </>
        )}

        {!payout && !payoutLoading && !payoutError && (
          <p className="text-sm text-ink-muted">
            No payout data recorded yet.
          </p>
        )}
      </div>
      <ConnectedAccounts
        flow="referral"
        nextPath="/referrals/dashboard"
        variant="referral"
      />

      <button
        onClick={() => nav("/referrals/change-password")}
        className="mt-6 w-full py-3 bg-surface-card border border-line-input rounded-xl text-accent font-semibold text-center hover:bg-surface-hover-accent hover:border-line-accent transition-all shadow-glow-soft"
      >
        Change Password
      </button>


      <button
        onClick={async () => {
          try {
            await fetch("/api/ref/logout", { method: "POST" });
          } catch {
            console.error("Referral logout failed");
          } finally {
            sessionStorage.removeItem("creatorId");
            nav("/referrals/login");
          }
        }}
        className="mt-3 w-full py-3 bg-danger-soft border border-danger-border rounded-xl text-danger-text text-center font-semibold hover:bg-danger-soft hover:border-danger-border transition-all shadow-danger-soft"
      >
        Log Out
      </button>


      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-lg transition-all ${
            toast.type === "success"
              ? "bg-success shadow-success-soft"
              : "bg-danger shadow-danger-soft"
          }`}
        >
          {toast.message}
        </div>
      )}


      {showLogsModal && (
        <div
          className={`fixed inset-0 z-[120] bg-black/60 backdrop-blur-lg flex items-center justify-center px-4 sm:px-6 transition-opacity duration-200 ${
            closingLogsModal
              ? "opacity-0 pointer-events-none"
              : logsModalAnimatingIn
              ? "opacity-100"
              : "opacity-0"
          }`}
          onClick={closeLogsModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-logs-title"
            className={`relative w-full max-w-5xl max-h-[70vh] sm:max-h-[50vh] bg-panel border border-info-border rounded-2xl shadow-glow-strong p-6 transition-all duration-500 ease-in-out ${
              closingLogsModal
                ? "opacity-0 scale-95"
                : logsModalAnimatingIn
                ? "opacity-100 scale-100"
                : "opacity-0 scale-95"
            } hover:shadow-glow-strong`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeLogsModal}
              className="absolute right-3 top-3 text-info-text hover:text-white transition text-2xl"
              aria-label="Close payment logs"
            >
              ×
            </button>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-muted">
                  Payment history
                </p>
                <h4
                  id="payment-logs-title"
                  className="text-xl font-bold text-ink"
                >
                  Payment Logs
                </h4>
                <p className="text-xs text-ink-muted">
                  Read-only. Only admins can add or edit payments.
                </p>
              </div>
              <span className="text-xs text-ink-muted">
                Total paid: {formatCurrency(payments.total)} | Entries:{" "}
                {(logs.xoc?.length || 0) + (logs.vertex?.length || 0)}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[45vh] max-h-[45vh] sm:h-[35vh] sm:max-h-[35vh]">
              <div className="bg-surface-input border border-line-input rounded-2xl p-4 no-scrollbar overflow-y-auto shadow-[0_0_20px_rgba(15,23,42,0.4)]">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-ink">
                    Vertex Max payments
                  </p>
                  <span className="text-xs text-ink-muted">
                    {logs.xoc?.length || 0} entries
                  </span>
                </div>
                <div className="space-y-2">
                  {logs.xoc?.length ? (
                    logs.xoc.map((entry) => (
                      <div
                        key={entry._key || entry.paidOn}
                        className="bg-surface-card border border-line-input rounded-lg px-3 py-2 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-sm font-semibold text-info-text">
                            {formatCurrency(entry.amount)}
                          </p>
                          {entry.note && (
                            <p className="text-xs text-ink-muted">
                              {entry.note}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-ink-muted">
                          {formatDate(entry.paidOn)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-ink-muted">
                      No payments logged yet.
                    </p>
                  )}
                </div>
              </div>

              <div className="bg-surface-input border border-line-input rounded-2xl p-4 no-scrollbar overflow-y-auto shadow-[0_0_20px_rgba(15,23,42,0.4)]">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-ink">
                    Vertex payments
                  </p>
                  <span className="text-xs text-ink-muted">
                    {logs.vertex?.length || 0} entries
                  </span>
                </div>
                <div className="space-y-2">
                  {logs.vertex?.length ? (
                    logs.vertex.map((entry) => (
                      <div
                        key={entry._key || entry.paidOn}
                        className="bg-surface-card border border-line-input rounded-lg px-3 py-2 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-sm font-semibold text-info-text">
                            {formatCurrency(entry.amount)}
                          </p>
                          {entry.note && (
                            <p className="text-xs text-ink-muted">
                              {entry.note}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-ink-muted">
                          {formatDate(entry.paidOn)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-ink-muted">
                      No payments logged yet.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      </section>
    </>
  );
}
