import React, { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

function useQuery() {
  const { search } = useLocation();
  return new URLSearchParams(search);
}

export default function RefReset() {
  const nav = useNavigate();
  const q = useQuery();
  const token = q.get("token");

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }

  if (!token) {
    return (
      <section className="pt-32 px-6 min-h-screen text-white flex flex-col items-center">
        <h1 className="text-3xl font-bold text-red-400">Invalid Link</h1>
        <p className="text-slate-400 mt-2">
          This password reset link is missing a token.
        </p>
        <button
          onClick={() => nav("/referrals/login")}
          className="mt-6 px-6 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 font-semibold text-white"
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
        showToast("success", "Password updated! Redirecting...");
        setTimeout(() => nav("/referrals/login"), 1500);
      }
    } catch (err) {
      console.error(err);
      showToast("error", "Server error");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-white flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Reset Password
      </h1>

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
            New Password
          </label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl
                       outline-none focus:border-sky-500 transition text-base text-white"
            placeholder="Enter new password"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sky-300 text-sm font-semibold">
            Confirm Password
          </label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl
                       outline-none focus:border-sky-500 transition text-base text-white"
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
              ? "bg-gray-700 opacity-40 cursor-not-allowed"
              : "bg-sky-600 hover:bg-sky-500 shadow-[0_0_25px_rgba(56,189,248,0.5)]"
          }`}
        >
          {loading ? "Updating..." : "Update Password"}
        </button>
      </form>

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
    </section>
  );
}
