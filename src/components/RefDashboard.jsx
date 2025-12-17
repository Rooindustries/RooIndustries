import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefDashboard() {
  const nav = useNavigate();
  const creatorId = localStorage.getItem("creatorId");

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
  const noScrollbarStyles = `
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  `;

  useEffect(() => {
    if (!creatorId) return nav("/referrals/login");

    const loadPayouts = async (refId) => {
      try {
        setPayoutLoading(true);
        setPayoutError(null);
        const res = await fetch(`/api/ref/payouts?id=${refId}`);
        const data = await res.json();

        if (!data.ok) {
          setPayout(null);
          setPayoutError(data.error || "Could not load payout data.");
          return;
        }

        setPayout(data);
      } catch (err) {
        console.error(err);
        setPayout(null);
        setPayoutError("Could not load payout data.");
      } finally {
        setPayoutLoading(false);
      }
    };

    async function load() {
      try {
        const res = await fetch(`/api/ref/getData?id=${creatorId}`);
        const data = await res.json();

        console.log("DASHBOARD DATA:", data);

        if (!data.ok) {
          try {
            localStorage.removeItem("creatorId");
          } catch (err) {
            console.error("Failed to clear creatorId after invalid data:", err);
          }
          return nav("/referrals/login");
        }

        const ref = data.referral || {};

        // normalize successfulReferrals (in case it's missing)
        const successfulReferrals = ref.successfulReferrals ?? 0;

        const normalized = {
          ...ref,
          successfulReferrals,
        };

        setCreator(normalized);
        setMax(normalized.maxCommissionPercent ?? 15);
        loadPayouts(creatorId);

        const bypass = normalized.bypassUnlock === true;
        const isUnlocked = successfulReferrals >= 5 || bypass;

        if (!isUnlocked) {
          setCommission(10);
          setDiscount(0);
        } else {
          setCommission(normalized.currentCommissionPercent ?? 10);
          setDiscount(normalized.currentDiscountPercent ?? 0);
        }
      } catch (e) {
        console.error(e);
        try {
          localStorage.removeItem("creatorId");
        } catch (err) {
          console.error("Failed to clear creatorId after error:", err);
        }
        nav("/referrals/login");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [creatorId, nav]);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  }

  const formatCurrency = (value) => `$${(Number(value) || 0).toFixed(2)}`;

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
    accent = "text-sky-300",
    className = "",
  }) => (
    <div className={`${cardClass} ${className}`}>
      <p className="text-[14px] uppercase text-slate-400 tracking-wide">
        {label}
      </p>
      <p className={`text-[30px] font-extrabold ${accent}`}>
        {formatCurrency(value)}
      </p>
    </div>
  );

  // Prevent background scroll while modal is open
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

  const closeLogsModal = () => {
    setClosingLogsModal(true);
    setTimeout(() => {
      setShowLogsModal(false);
      setClosingLogsModal(false);
    }, 200);
  };

  // trigger fade-in on open
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
    "bg-gradient-to-b from-[#0c1a2f] via-[#0a1324] to-[#072239] p-6 rounded-2xl border border-sky-700/40 shadow-[0_0_25px_rgba(56,189,248,0.3)] backdrop-blur-md";
  const cardClass =
    "bg-[#0c162a] border border-sky-800/50 rounded-xl p-4 h-full flex flex-col justify-between";

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
          id: creatorId,
          commissionPercent: commission,
          discountPercent: discount,
        }),
      });

      const result = await res.json();
      if (!result.ok) showToast("error", result.error || "Failed to save");
      else showToast("success", "Saved successfully!");
    } catch (err) {
      console.error(err);
      showToast("error", "Server error");
    }
    setSaving(false);
  }

  if (loading)
    return <p className="text-center text-white pt-32">Loading...</p>;
  if (!creator) return null;

  const currentRefs = creator.successfulReferrals ?? 0;
  const refsLeft = Math.max(0, 5 - currentRefs);

  // referral code + link
  const referralCode = creator.slug?.current || "";
  const referralLink = `${window.location.origin}/?ref=${referralCode}`;

  const payoutData = payout || {};
  const earnings = payoutData.earnings || {};
  const payments = payoutData.payments || {};
  const logs = payoutData.logs || {};

  async function copyReferralLink() {
    try {
      await navigator.clipboard.writeText(referralLink);
      showToast("success", "Referral link copied!");
    } catch (err) {
      console.error(err);
      showToast("error", "Failed to copy link");
    }
  }

  return (
    <>
      <style>{noScrollbarStyles}</style>
      <section className="pt-28 px-6 max-w-xl mx-auto text-white mb-20">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow">
        Welcome, {creator.name}
      </h1>

      <p className="mt-1 text-center opacity-70">
        Referral Code: <b className="text-sky-400">{referralCode}</b>
      </p>

      {/* 🔗 Referral Link */}
      <div className={`mt-8 ${panelClass} space-y-2`}>
        <p className="text-sm font-semibold text-sky-200 mb-2">
          Your referral link
        </p>

        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <input
            type="text"
            value={referralLink}
            readOnly
            className="flex-1 bg-[#050b16] border border-sky-800/40 rounded-md px-3 py-2 text-xs sm:text-sm text-slate-100 truncate"
          />

          <button
            onClick={copyReferralLink}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md text-xs sm:text-sm font-semibold"
          >
            Copy
          </button>
        </div>

        <p className="mt-2 text-[11px] text-slate-400">
          Share this link with your viewers. Anyone who books through it will
          use your code.
        </p>
      </div>

      <div className={`mt-12 ${panelClass} space-y-8`}>
        {/* STATS CARD */}
        <div className="bg-[#050b16] border border-sky-800/40 rounded-xl px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase text-slate-400 tracking-wide">
              Total successful referrals
            </p>
            <p className="text-2xl font-extrabold text-sky-300">
              {currentRefs}
            </p>
          </div>
          <div className="text-right text-xs text-slate-400">
            {unlocked ? (
              <p className="text-green-300 font-semibold">
                Perks unlocked 🎉
                <br />
                You can now adjust commission & discount.
              </p>
            ) : (
              <p>
                {refsLeft} more referral{refsLeft === 1 ? "" : "s"} to unlock
                full control.
              </p>
            )}
          </div>
        </div>

        {/* COMMISSION CONTROL */}
        <div
          className={`space-y-2 ${
            !unlocked ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <p className="text-sky-300 font-semibold">Commission (%)</p>
          <div className="flex items-center justify-between bg-[#0c162a] p-3 rounded-xl border border-sky-800/40">
            <button
              onClick={() => adjustCommission(-1)}
              className="px-4 py-2 bg-sky-700/40 hover:bg-sky-600/40 rounded-xl text-xl font-bold transition"
            >
              –
            </button>
            <span className="text-xl font-bold">{commission}%</span>
            <button
              onClick={() => adjustCommission(1)}
              className="px-4 py-2 bg-sky-700/40 hover:bg-sky-600/40 rounded-xl text-xl font-bold transition"
            >
              +
            </button>
          </div>
        </div>

        {/* DISCOUNT CONTROL */}
        <div
          className={`space-y-2 ${
            !unlocked ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <p className="text-sky-300 font-semibold">Viewer Discount (%)</p>
          <div className="flex items-center justify-between bg-[#0c162a] p-3 rounded-xl border border-sky-800/40">
            <button
              onClick={() => adjustDiscount(-1)}
              className="px-4 py-2 bg-sky-700/40 hover:bg-sky-600/40 rounded-xl text-xl font-bold transition"
            >
              –
            </button>
            <span className="text-xl font-bold">{discount}%</span>
            <button
              onClick={() => adjustDiscount(1)}
              className="px-4 py-2 bg-sky-700/40 hover:bg-sky-600/40 rounded-xl text-xl font-bold transition"
            >
              +
            </button>
          </div>
        </div>

        {/* TOTAL */}
        <div
          className={`text-center font-semibold text-lg ${
            invalid ? "text-red-400" : "text-green-300"
          }`}
        >
          Total: {total}% / Max {max}%
        </div>

        {/* SAVE BUTTON */}
        <button
          onClick={save}
          disabled={invalid || saving || !unlocked}
          className={`w-full py-3 rounded-xl font-bold transition-all ${
            invalid || !unlocked
              ? "bg-gray-700 cursor-not-allowed opacity-40"
              : "bg-sky-600 hover:bg-sky-500 shadow-[0_0_20px_rgba(56,189,248,0.4)]"
          }`}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      {/* PAYOUT SUMMARY (read-only for creators) */}
      <div className={`mt-10 ${panelClass} space-y-4`}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">
              Payouts
            </p>
            <h3 className="text-lg sm:text-xl font-bold text-white">
              Earnings & Payments
            </h3>
            <p className="text-xs text-slate-400">
              Calculated from your referral sales.
            </p>
          </div>
          <span className="text-xs text-slate-400">
            {payoutLoading ? "Updating..." : "Auto-updated"}
          </span>
        </div>

        {payoutError && (
          <div className="bg-red-500/10 border border-red-500/40 text-red-200 text-sm rounded-xl px-3 py-2">
            {payoutError}
          </div>
        )}

        {!payout && payoutLoading && (
          <p className="text-sm text-slate-400">Loading payout data...</p>
        )}

            {payout && (
              <>
            <div className="grid sm:grid-cols-2 gap-3 auto-rows-fr">
              <StatCard label="Total owed - XOC" value={earnings.xoc} />
              <StatCard label="Total owed - Vertex" value={earnings.vertex} />
              <StatCard
                label="Total paid"
                value={payments.total}
                accent="text-emerald-300"
              />
              <div className={`${cardClass} flex flex-col gap-2`}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-white">
                    Payment Logs
                  </p>
                  <span className="text-xs text-slate-400">
                    {logs.xoc?.length + logs.vertex?.length || 0} entries
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  View your XOC and Vertex payment history.
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
            </div>

          </>
        )}

        {!payout && !payoutLoading && !payoutError && (
          <p className="text-sm text-slate-400">
            No payout data recorded yet.
          </p>
        )}
      </div>

      {/* CHANGE PASSWORD */}
      <button
        onClick={() => nav("/referrals/change-password")}
        className="mt-6 w-full py-3 bg-[#0f1a2e] border border-sky-700/40 rounded-xl text-sky-300 font-semibold text-center hover:bg-sky-900/30 hover:border-sky-500/40 transition-all shadow-[0_0_10px_rgba(56,189,248,0.2)] hover:shadow-[0_0_20px_rgba(56,189,248,0.35)]"
      >
        Change Password
      </button>

      {/* LOGOUT */}
      <button
        onClick={() => {
          localStorage.removeItem("creatorId");
          nav("/referrals/login");
        }}
        className="mt-3 w-full py-3 bg-[#0a1220] border border-red-700/30 rounded-xl text-red-300 text-center font-semibold hover:bg-red-900/30 hover:border-red-500/40 transition-all shadow-[0_0_10px_rgba(239,68,68,0.25)] hover:shadow-[0_0_20px_rgba(239,68,68,0.45)]"
      >
        Log Out
      </button>

      {/* TOAST */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-lg transition-all ${
            toast.type === "success"
              ? "bg-green-600 shadow-[0_0_25px_rgba(34,197,94,0.5)]"
              : "bg-red-600 shadow-[0_0_25px_rgba(239,68,68,0.5)]"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* PAYMENT LOGS MODAL (full-screen) */}
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
            className={`relative w-full max-w-5xl max-h-[70vh] sm:max-h-[50vh] bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 border border-sky-400/60 rounded-2xl shadow-[0_0_35px_rgba(56,189,248,0.4)] p-6 transition-all duration-500 ease-in-out ${
              closingLogsModal
                ? "opacity-0 scale-95"
                : logsModalAnimatingIn
                ? "opacity-100 scale-100"
                : "opacity-0 scale-95"
            } hover:shadow-[0_0_42px_rgba(56,189,248,0.5)]`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeLogsModal}
              className="absolute right-3 top-3 text-sky-200 hover:text-white transition text-2xl"
              aria-label="Close payment logs"
            >
              ×
            </button>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">
                  Payment history
                </p>
                <h4 className="text-xl font-bold text-white">Payment Logs</h4>
                <p className="text-xs text-slate-400">
                  Read-only. Only admins can add or edit payments.
                </p>
              </div>
              <span className="text-xs text-slate-400">
                Total entries: {(logs.xoc?.length || 0) + (logs.vertex?.length || 0)}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[45vh] max-h-[45vh] sm:h-[35vh] sm:max-h-[35vh]">
              <div className="bg-[#0c162a] border border-sky-700/60 rounded-2xl p-4 no-scrollbar overflow-y-auto shadow-[0_0_20px_rgba(15,23,42,0.4)]">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-white">
                    XOC payments
                  </p>
                  <span className="text-xs text-slate-400">
                    {logs.xoc?.length || 0} entries
                  </span>
                </div>
                <div className="space-y-2">
                  {logs.xoc?.length ? (
                    logs.xoc.map((entry) => (
                      <div
                        key={entry._key || entry.paidOn}
                        className="bg-[#0a1324] border border-sky-900/50 rounded-lg px-3 py-2 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-sm font-semibold text-sky-200">
                            {formatCurrency(entry.amount)}
                          </p>
                          {entry.note && (
                            <p className="text-xs text-slate-400">
                              {entry.note}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-slate-400">
                          {formatDate(entry.paidOn)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">
                      No payments logged yet.
                    </p>
                  )}
                </div>
              </div>

              <div className="bg-[#0c162a] border border-sky-700/60 rounded-2xl p-4 no-scrollbar overflow-y-auto shadow-[0_0_20px_rgba(15,23,42,0.4)]">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-white">
                    Vertex payments
                  </p>
                  <span className="text-xs text-slate-400">
                    {logs.vertex?.length || 0} entries
                  </span>
                </div>
                <div className="space-y-2">
                  {logs.vertex?.length ? (
                    logs.vertex.map((entry) => (
                      <div
                        key={entry._key || entry.paidOn}
                        className="bg-[#0a1324] border border-sky-900/50 rounded-lg px-3 py-2 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-sm font-semibold text-sky-200">
                            {formatCurrency(entry.amount)}
                          </p>
                          {entry.note && (
                            <p className="text-xs text-slate-400">
                              {entry.note}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-slate-400">
                          {formatDate(entry.paidOn)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">
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
