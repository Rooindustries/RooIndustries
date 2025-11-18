import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefChangePassword() {
  const nav = useNavigate();
  const creatorId = localStorage.getItem("creatorId");

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  if (!creatorId) nav("/referrals/login");

  function showToast(type, msg) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 2200);
  }

  async function update() {
    if (!pass1 || !pass2) return showToast("error", "Fill in both fields");
    if (pass1 !== pass2) return showToast("error", "Passwords do not match");

    setLoading(true);

    try {
      const res = await fetch("/api/ref/hashPassword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId, password: pass1 }),
      });

      const data = await res.json();

      if (!data.ok) return showToast("error", "Failed to update password");

      showToast("success", "Password updated!");
      setPass1("");
      setPass2("");
      setTimeout(() => nav("/referrals/dashboard"), 1200);
    } catch (err) {
      console.error(err);
      showToast("error", "Server error");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-white flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Change Password
      </h1>

      <div
        className="mt-10 w-full max-w-md bg-[#0a1324]/70 backdrop-blur-xl 
                      border border-sky-700/40 shadow-[0_0_35px_rgba(56,189,248,0.35)]
                      rounded-2xl p-8 space-y-6"
      >
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            New Password
          </label>
          <input
            type="password"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl
                       outline-none focus:border-sky-500 transition text-base"
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
                       outline-none focus:border-sky-500 transition text-base"
            placeholder="Confirm new password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
          />
        </div>

        <button
          onClick={update}
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all
            ${
              loading
                ? "bg-gray-700 opacity-40 cursor-not-allowed"
                : "bg-sky-600 hover:bg-sky-500 shadow-[0_0_25px_rgba(56,189,248,0.5)]"
            }
          `}
        >
          {loading ? "Saving..." : "Save Password"}
        </button>

        <button
          type="button"
          onClick={() => nav("/referrals/dashboard")}
          className="w-full text-sm text-sky-400 opacity-80 hover:opacity-100 mt-2"
        >
          Back to Dashboard
        </button>
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl 
          text-white text-sm font-semibold shadow-lg transition-all
          ${
            toast.type === "success"
              ? "bg-green-600 shadow-[0_0_25px_rgba(34,197,94,0.5)]"
              : "bg-red-600 shadow-[0_0_25px_rgba(239,68,68,0.5)]"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </section>
  );
}
