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
    const creatorId = localStorage.getItem("creatorId");
    const remembered = localStorage.getItem("refRememberMe") === "true";

    if (creatorId && remembered) {
      nav("/referrals/dashboard");
      return;
    }

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
        body: JSON.stringify({ code, password }),
      });

      const data = await res.json();
      if (!data.ok) {
        showToast("error", "Wrong referral code or password.");
        setLoading(false);
        return;
      }

      localStorage.setItem("creatorId", data.creatorId);

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
    <section className="pt-32 px-6 min-h-screen text-white flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Referral Creator Login
      </h1>

      <p className="text-slate-400 mt-3 text-center max-w-md text-base">
        Access your commission & discount dashboard and manage your referral
        settings.
      </p>

      {/* Bigger Form Card */}
      <form
        onSubmit={handleLogin}
        className="mt-12 w-full max-w-md 
                  bg-[#0a1324]/70 backdrop-blur-xl 
                  border border-sky-700/40 
                  shadow-[0_0_35px_rgba(56,189,248,0.35)]
                  rounded-2xl p-8 space-y-7"
      >
        {/* Referral Code */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            Referral Code
          </label>
          <input
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl
                       outline-none focus:border-sky-500 transition text-base"
            placeholder="Referral Code"
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
        </div>

        {/* Password */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">Password</label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl
                       outline-none focus:border-sky-500 transition text-base"
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
                    ? "border-sky-400 bg-sky-500/80 shadow-[0_0_10px_rgba(56,189,248,0.7)]"
                    : "border-sky-700 bg-[#020617]"
                }`}
            >
              {rememberMe && (
                <span className="block w-2 h-2 rounded-[4px] bg-white" />
              )}
            </div>
            <span className="text-xs text-slate-300">Remember me</span>
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
            className="text-xs text-sky-400 opacity-80 hover:opacity-100"
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
                ? "bg-gray-700 opacity-40 cursor-not-allowed"
                : "bg-sky-600 hover:bg-sky-500 shadow-[0_0_25px_rgba(56,189,248,0.5)]"
            }
          `}
        >
          {loading ? "Logging in..." : "Login"}
        </button>
      </form>

      {/* Register Button */}
      <div className="mt-4 flex flex-col items-center gap-2">
        <p className="text-xs text-slate-400">
          Don&apos;t have a creator account yet?
        </p>
        <button
          type="button"
          onClick={() => nav("/referrals/register")}
          className="px-5 py-2 rounded-xl text-sm font-semibold bg-sky-700 hover:bg-sky-600
                     shadow-[0_0_20px_rgba(56,189,248,0.5)] transition-all"
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
