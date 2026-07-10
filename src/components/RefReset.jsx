import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const RESET_TOKEN_STORAGE_KEY = "referral_reset_token";

const readResetToken = ({ hash }) => {
  if (typeof window === "undefined") return "";
  const fragmentToken = new URLSearchParams(
    String(hash || "").replace(/^#/, "")
  ).get("token");
  const token = String(
    fragmentToken ||
      window.sessionStorage.getItem(RESET_TOKEN_STORAGE_KEY) ||
      ""
  ).trim();
  if (token) window.sessionStorage.setItem(RESET_TOKEN_STORAGE_KEY, token);
  return token;
};

export default function RefReset() {
  const nav = useNavigate();
  const location = useLocation();
  const [token, setToken] = useState("");
  const [tokenReady, setTokenReady] = useState(false);

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    setToken(readResetToken(location));
    setTokenReady(true);
    if (!location.search && !location.hash) return;
    nav(location.pathname, { replace: true });
  }, [location.hash, location.pathname, location.search, nav]);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }

  if (!tokenReady) return null;

  if (!token) {
    return (
      <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
        <h1 className="text-3xl font-bold text-danger-text">Invalid Link</h1>
        <p className="text-ink-muted mt-2">
          This password reset link is missing a token.
        </p>
        <button
          onClick={() => nav("/referrals/login")}
          className="mt-6 px-6 py-3 rounded-xl bg-accent-strong hover:bg-accent font-semibold text-accent-contrast"
        >
          Go to Login
        </button>
      </section>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!pass1 || !pass2) return showToast("error", "Fill in both fields");
    if (pass1 !== pass2) return showToast("error", "Passwords do not match");

    setLoading(true);

    try {
      const res = await fetch("/api/ref/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pass1 }),
      });

      const data = await res.json();

      if (!data.ok) {
        showToast("error", data.error || "Reset failed");
      } else {
        sessionStorage.removeItem(RESET_TOKEN_STORAGE_KEY);
        showToast("success", "Password updated! Redirecting...");
        setTimeout(() => nav("/referrals/login"), 1500);
      }
    } catch {
      console.error("Referral password reset failed");
      showToast("error", "Server error");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Reset Password
      </h1>

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
            New Password
          </label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="Enter new password"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
          />
        </div>

        <div>
          <label className="text-accent text-sm font-semibold">
            Confirm Password
          </label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="Confirm new password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
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
          {loading ? "Updating..." : "Update Password"}
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
