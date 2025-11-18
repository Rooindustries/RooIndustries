import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefLogin() {
  const nav = useNavigate();

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  }

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
      console.log("LOGIN RESPONSE:", data);

      if (!data.ok) {
        showToast("error", "Wrong referral code or password.");
        setLoading(false);
        return;
      }

      localStorage.setItem("creatorId", data.creatorId);
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

        <button
          type="button"
          onClick={() => nav("/referrals/forgot")}
          className="w-full text-sm text-sky-400 opacity-80 hover:opacity-100 mt-3"
        >
          Forgot your password?
        </button>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all
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
