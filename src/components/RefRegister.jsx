import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function RefRegister() {
  const nav = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [slug, setSlug] = useState("");
  const [slugAvailable, setSlugAvailable] = useState(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2800);
  }
  useEffect(() => {
    const savedEmail = localStorage.getItem("referral_prefill_email");
    if (savedEmail) {
      setEmail(savedEmail);
      localStorage.removeItem("referral_prefill_email");
    }
  }, []);
  // Debounced slug availability check
  useEffect(() => {
    if (!slug) {
      setSlugAvailable(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/ref/validateReferral?code=${encodeURIComponent(
            slug.toLowerCase()
          )}`
        );
        const data = await res.json();
        // if API returns not found → available, if ok true → taken
        setSlugAvailable(!data.ok);
      } catch (err) {
        // network or server error: we don't assume taken
        setSlugAvailable(null);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [slug]);

  async function handleRegister(e) {
    e.preventDefault();

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPaypalEmail = paypalEmail.trim().toLowerCase();
    const trimmedSlug = slug.trim().toLowerCase();
    const trimmedPassword = password.trim();
    const trimmedConfirm = confirm.trim();

    // Basic validation
    if (
      !trimmedName ||
      !trimmedEmail ||
      !trimmedPaypalEmail ||
      !trimmedSlug ||
      !trimmedPassword ||
      !trimmedConfirm
    ) {
      showToast("error", "Please fill in all fields.");
      return;
    }

    // basic email format check
    const emailRegex = /\S+@\S+\.\S+/;
    if (!emailRegex.test(trimmedEmail)) {
      showToast("error", "Please enter a valid login email address.");
      return;
    }

    if (!emailRegex.test(trimmedPaypalEmail)) {
      showToast("error", "Please enter a valid PayPal email address.");
      return;
    }

    if (trimmedPassword !== trimmedConfirm) {
      showToast("error", "Passwords do not match.");
      return;
    }

    // Ensure slug availability checked (force-check if null)
    if (slugAvailable === false) {
      showToast("error", "Referral code is already taken.");
      return;
    }
    if (slugAvailable === null) {
      try {
        const resCheck = await fetch(
          `/api/ref/validateReferral?code=${encodeURIComponent(trimmedSlug)}`
        );
        const dataCheck = await resCheck.json();
        if (!dataCheck.ok) {
          setSlugAvailable(false);
          showToast("error", "Referral code is already taken.");
          return;
        } else {
          setSlugAvailable(true); // available
        }
      } catch (err) {
        showToast("error", "Could not validate referral code. Try again.");
        return;
      }
    }

    setLoading(true);

    try {
      const res = await fetch("/api/ref/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          paypalEmail: trimmedPaypalEmail,
          slug: trimmedSlug,
          password: trimmedPassword,
        }),
      });

      const data = await res.json();
      if (!data.ok) {
        showToast("error", data.error || "Registration failed.");
        setLoading(false);
        return;
      }

      // Optionally sign them in automatically: you can store creatorId or call your login endpoint
      localStorage.setItem("creatorId", data.referralId);
      showToast("success", "Registered! Redirecting to dashboard...");
      setTimeout(() => nav("/referrals/dashboard"), 900);
    } catch (err) {
      console.error("REGISTER ERROR:", err);
      showToast("error", "Server error.");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-white flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-sky-300 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Referral Creator Registration
      </h1>
      <p className="text-slate-400 mt-3 text-center max-w-md text-base">
        Create your referral account and start earning commissions.
      </p>

      <form
        onSubmit={handleRegister}
        className="mt-12 w-full max-w-md 
                  bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 backdrop-blur-xl 
                  border border-sky-700/40 
                  shadow-[0_0_35px_rgba(56,189,248,0.35)]
                  rounded-2xl p-8 space-y-7"
      >
        {/* Name */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl outline-none focus:border-sky-500 transition text-base"
          />
        </div>

        {/* Email */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            Login Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email you sign in with"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl outline-none focus:border-sky-500 transition text-base"
          />
        </div>

        {/* PayPal Email */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            PayPal Email (for payouts)
          </label>
          <input
            type="email"
            value={paypalEmail}
            onChange={(e) => setPaypalEmail(e.target.value)}
            placeholder="Email used for your PayPal account"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl outline-none focus:border-sky-500 transition text-base"
          />
          <p className="text-slate-400 text-xs mt-1">
            We’ll send your commissions to this PayPal address.
          </p>
        </div>

        {/* Referral Code */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            Referral Code
          </label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="Custom referral code (e.g. yourname)"
            className={`w-full p-4 mt-1 bg-[#0c162a] border rounded-xl outline-none focus:border-sky-500 transition text-base ${
              slugAvailable === false ? "border-red-500" : "border-sky-800/40"
            }`}
          />
          {slugAvailable === false && (
            <p className="text-red-400 text-sm mt-1">
              This referral code is already taken.
            </p>
          )}
          {slugAvailable === true && slug && (
            <p className="text-green-400 text-sm mt-1">
              Referral code is available.
            </p>
          )}
        </div>

        {/* Password */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl outline-none focus:border-sky-500 transition text-base"
          />
        </div>

        {/* Confirm Password */}
        <div>
          <label className="text-sky-300 text-sm font-semibold">
            Confirm Password
          </label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            className="w-full p-4 mt-1 bg-[#0c162a] border border-sky-800/40 rounded-xl outline-none focus:border-sky-500 transition text-base"
          />
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className={`glow-button w-full py-4 rounded-xl font-bold text-lg transition-all ${
            loading ? "opacity-50 cursor-not-allowed" : ""
          }`}
        >
          {loading ? "Registering..." : "Register"}
          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </button>
      </form>

      {/* Toast */}
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
