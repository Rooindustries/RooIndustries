import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function RefLogin() {
  const nav = useNavigate();

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  }

  // Load saved referral code
  useEffect(() => {
    const checkSession = async () => {
      try {
        const sessionRes = await fetch("/api/ref/getData");
        if (sessionRes.ok) {
          nav("/referrals/dashboard");
          return;
        }
      } catch (err) {
        console.error("Failed to check referral session:", err);
      }
    };
    checkSession();

    const savedCode = localStorage.getItem("refLoginCode");
    if (savedCode) {
      setCode(savedCode);
      setRememberMe(true);
    }
  }, [nav]);

  async function handleLogin(e) {
    e.preventDefault();

    if (!code || !password) {
      showToast("error", "Please fill in all fields.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/ref/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, password, rememberMe }),
      });

      const data = await res.json();
      if (!data.ok) {
        showToast("error", "Wrong referral code or password.");
        setLoading(false);
        return;
      }

      if (data?.creatorId) {
        localStorage.setItem("creatorId", data.creatorId);
      }

      // Handle remember me
      if (rememberMe) {
        localStorage.setItem("refLoginCode", code);
        localStorage.setItem("refRememberMe", "true");
      } else {
        localStorage.removeItem("refLoginCode");
        localStorage.removeItem("refRememberMe");
      }

      showToast("success", "Logging in...");

      setTimeout(() => nav("/referrals/dashboard"), 500);
    } catch (err) {
      console.error(err);
      showToast("error", "Server error.");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Referral Creator Login
      </h1>

      <p className="text-ink-muted mt-3 text-center max-w-md text-base">
        Access your commission & discount dashboard and manage your referral
        settings.
      </p>

      {/* Bigger Form Card */}
      <form
        onSubmit={handleLogin}
        className="mt-12 w-full max-w-md
                  bg-surface-card backdrop-blur-xl
                  border border-line-input
                  shadow-[var(--shadow-card-glow)]
                  rounded-2xl p-8 space-y-7"
      >
        {/* Referral Code */}
        <div>
          <label className="text-accent text-sm font-semibold">
            Referral Code
          </label>
          <input
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Referral Code"
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
        </div>

        {/* Password */}
        <div>
          <label className="text-accent text-sm font-semibold">Password</label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {/* Remember Me */}
        <div className="flex items-center justify-between mt-1">
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <div
              className={`w-4 h-4 rounded-[6px] border transition-all flex items-center justify-center
                ${
                  rememberMe
                    ? "border-info-border bg-info shadow-info-soft"
                    : "border-line-input bg-canvas"
                }`}
            >
              {rememberMe && (
                <span className="block w-2 h-2 rounded-[4px] bg-white" />
              )}
            </div>
            <span className="text-xs text-ink-secondary">Remember me</span>
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="hidden"
            />
          </label>

          <button
            type="button"
            onClick={() => nav("/referrals/forgot")}
            className="text-xs text-accent opacity-80 hover:opacity-100"
          >
            Forgot your password?
          </button>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className={`w-full mt-4 py-4 rounded-xl font-bold text-lg transition-all
            ${
              loading
                ? "bg-surface-input opacity-40 cursor-not-allowed"
                : "bg-accent-strong hover:bg-accent text-accent-contrast shadow-glow-soft"
            }
          `}
        >
          {loading ? "Logging in..." : "Login"}
        </button>
      </form>

      {/* Register Button */}
      <div className="mt-4 flex flex-col items-center gap-2">
        <p className="text-xs text-ink-muted">
          Don&apos;t have a creator account yet?
        </p>
        <button
          type="button"
          onClick={() => nav("/referrals/register")}
          className="px-5 py-2 rounded-xl text-sm font-semibold bg-accent-strong hover:bg-accent text-accent-contrast
                     shadow-glow-soft transition-all"
        >
          Create an account
        </button>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-lg transition-all
            ${
              toast.type === "success"
                ? "bg-success shadow-success-soft"
                : "bg-danger shadow-danger-soft"
            }
          `}
        >
          {toast.message}
        </div>
      )}
    </section>
  );
}
