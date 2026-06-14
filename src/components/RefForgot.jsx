import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefForgot() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
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

      const data = await res.json();

      if (data.ok) {
        showToast("success", "Reset link sent! Check your inbox.");
        setEmail("");
      } else {
        showToast("error", data.error || "Failed to send link");
      }
    } catch (err) {
      console.error(err);
      showToast("error", "Server error.");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Forgot Password
      </h1>

      <p className="text-ink-muted mt-3 text-center max-w-md text-base">
        Enter the email attached to your referral account and we&apos;ll send
        you a reset link.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-10 w-full max-w-md
                  bg-surface-card backdrop-blur-xl
                  border border-line-input
                  shadow-[var(--shadow-card-glow)]
                  rounded-2xl p-8 space-y-6"
      >
        <div>
          <label className="text-accent text-sm font-semibold">
            Creator Email
          </label>
          <input
            type="email"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value.trim())}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all ${
            loading
              ? "bg-surface-input opacity-40 cursor-not-allowed"
              : "bg-accent-strong hover:bg-accent text-accent-contrast shadow-glow-soft"
          }`}
        >
          {loading ? "Sending..." : "Send Reset Link"}
        </button>

        <button
          type="button"
          onClick={() => nav("/referrals/login")}
          className="w-full text-sm text-accent opacity-80 hover:opacity-100 mt-1"
        >
          Back to Login
        </button>
      </form>

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
    </section>
  );
}
