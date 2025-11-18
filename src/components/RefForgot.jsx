import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefForgot() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email) return showToast("error", "Enter your email");

    setLoading(true);

    try {
      const res = await fetch("/api/ref/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      showToast("success", "If the email exists, a reset link was sent.");
      setEmail("");
    } catch (err) {
      console.error(err);
      showToast("error", "Server error.");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-white flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Forgot Password
      </h1>

      <p className="text-slate-400 mt-3 text-center max-w-md text-base">
        Enter the email attached to your referral account and we&apos;ll send
        you a reset link.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-10 w-full max-w-md 
                  bg-[#0a1324]/70 backdrop-blur-xl 
                  border border-sky-700/40 
                  shadow-[0_0_35px_rgba(56,189,248,0.35)]
                  rounded-2xl p-8 space-y-6"
      >
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            Creator Email
          </label>
          <input
            type="email"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl
                       outline-none focus:border-sky-500 transition text-base"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value.trim())}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all
            ${
              loading
                ? "bg-gray-700 opacity-40 cursor-not-allowed"
                : "bg-sky-600 hover:bg-sky-500 shadow-[0_0_25px_rgba(56,189,248,0.5)]"
            }`}
        >
          {loading ? "Sending..." : "Send Reset Link"}
        </button>

        <button
          type="button"
          onClick={() => nav("/referrals/login")}
          className="w-full text-sm text-sky-400 opacity-80 hover:opacity-100 mt-1"
        >
          Back to Login
        </button>
      </form>

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-lg transition-all
          ${
            toast.type === "success"
              ? "bg-green-600 shadow-[0_0_25px_rgba(34,197,94,0.5)]"
              : "bg-red-600 shadow-[0_0_25px_rgba(239,68,68,0.5)]"
          }`}
        >
          {toast.message}
        </div>
      )}
    </section>
  );
}
