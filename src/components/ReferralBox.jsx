import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function ReferralBox() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");

  function handleStart() {
    if (!email || !email.includes("@")) return;

    localStorage.setItem("referral_prefill_email", email);
    nav("/referrals/register");
  }

  const isValid = !!email && email.includes("@");

  return (
    <div className="mt-12 bg-[#0a1324]/80 border border-indigo-500/30 rounded-2xl p-6 shadow-[0_0_30px_rgba(99,102,241,0.2)] backdrop-blur-md max-w-4xl mx-auto md:flex md:items-center md:justify-between md:gap-8">
      {/* Left Side: Text Content */}
      <div className="text-left mb-5 md:mb-0 md:flex-1">
        <h3 className="text-2xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-sky-300 to-indigo-300 drop-shadow-sm">
          Join the Referral Program
        </h3>
        <p className="text-sm text-slate-400 leading-relaxed">
          Are you a creator? Enter your email to get started with registration.
        </p>
      </div>

      {/* Right Side: Input and Button */}
      <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto md:flex-initial sm:items-stretch">
        <input
          type="email"
          placeholder="Enter your email..."
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 md:w-64 bg-[#050b16] border border-indigo-900/60 focus:border-sky-500/60 rounded-xl px-4 py-3 text-sm text-slate-200 outline-none transition-all placeholder:text-slate-600 shadow-inner"
        />

        <button
          onClick={handleStart}
          disabled={!isValid}
          className="
            glow-button
            inline-flex items-center justify-center gap-2
            rounded-xl
            px-4 sm:px-5 py-3
            text-sm font-semibold text-white
            ring-1 ring-sky-700/50
            transition-all duration-300
            active:translate-y-px
            w-full sm:w-auto

            bg-gradient-to-r from-sky-600 to-indigo-600
            hover:from-sky-500 hover:to-indigo-500
            shadow-[0_10px_30px_rgba(56,189,248,0.35)]

            disabled:opacity-50 disabled:cursor-not-allowed
            disabled:hover:from-sky-600 disabled:hover:to-indigo-600
          "
        >
          <span className="relative z-10 drop-shadow">Get Started</span>

          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </button>
      </div>
    </div>
  );
}
