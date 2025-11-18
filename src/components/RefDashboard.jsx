import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefDashboard() {
  const nav = useNavigate();
  const creatorId = localStorage.getItem("creatorId");

  const [creator, setCreator] = useState(null);
  const [commission, setCommission] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [max, setMax] = useState(0);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!creatorId) return nav("/referrals/login");

    async function load() {
      try {
        const res = await fetch(`/api/ref/getData?id=${creatorId}`);
        const data = await res.json();

        if (!data.ok) return nav("/referrals/login");

        setCreator(data.referral);
        setCommission(data.referral.currentCommissionPercent);
        setDiscount(data.referral.currentDiscountPercent);
        setMax(data.referral.maxCommissionPercent);
      } catch (e) {
        console.error(e);
        nav("/referrals/login");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  }

  const total = commission + discount;
  const invalid = total > max;

  function adjustCommission(delta) {
    const newVal = commission + delta;
    if (newVal < 0) return;
    if (newVal + discount > max) return;
    setCommission(newVal);
  }

  function adjustDiscount(delta) {
    const newVal = discount + delta;
    if (newVal < 0) return;
    if (newVal + commission > max) return;
    setDiscount(newVal);
  }

  async function save() {
    if (invalid) return;

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

  return (
    <section className="pt-28 px-6 max-w-xl mx-auto text-white mb-20">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow">
        Welcome, {creator.name}
      </h1>

      <p className="mt-1 text-center opacity-70">
        Referral Code: <b className="text-sky-400">{creator.slug.current}</b>
      </p>

      <div className="mt-12 bg-[#0a1324]/80 p-6 rounded-2xl border border-sky-700/40 shadow-[0_0_25px_rgba(56,189,248,0.3)] space-y-8 backdrop-blur-md">
        {/* COMMISSION CONTROL */}
        <div className="space-y-2">
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
        <div className="space-y-2">
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
          disabled={invalid || saving}
          className={`w-full py-3 rounded-xl font-bold transition-all
            ${
              invalid
                ? "bg-gray-700 cursor-not-allowed opacity-40"
                : "bg-sky-600 hover:bg-sky-500 shadow-[0_0_20px_rgba(56,189,248,0.4)]"
            }
          `}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      {/* LOGOUT */}
      <button
        onClick={() => nav("/referrals/change-password")}
        className="mt-6 w-full py-3 
             bg-[#0f1a2e] border border-sky-700/40 
             rounded-xl text-sky-300 text-center font-semibold
             hover:bg-sky-900/30 hover:border-sky-500/40
             transition-all shadow-[0_0_10px_rgba(56,189,248,0.2)]
             hover:shadow-[0_0_20px_rgba(56,189,248,0.35)]"
      >
        Change Password
      </button>

      <button
        onClick={() => {
          localStorage.removeItem("creatorId");
          nav("/referrals/login");
        }}
        className="mt-3 w-full py-3 
             bg-[#0a1220] border border-red-700/30 
             rounded-xl text-red-300 text-center font-semibold
             hover:bg-red-900/30 hover:border-red-500/40
             transition-all shadow-[0_0_10px_rgba(239,68,68,0.25)]
             hover:shadow-[0_0_20px_rgba(239,68,68,0.45)]"
      >
        Log Out
      </button>

      {/* TOAST */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-lg transition-all
          ${
            toast.type === "success"
              ? "bg-green-600 shadow-[0_0_25px_rgba(34,197,94,0.5)]"
              : "bg-red-600 shadow-[0_0_25px_rgba(239,68,68,0.5)]"
          }
        `}
        >
          {toast.message}
        </div>
      )}
    </section>
  );
}
