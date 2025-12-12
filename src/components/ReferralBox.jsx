import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function ReferralBox() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");

  function handleStart() {
    if (!email || !email.includes("@")) return;

    // Save the email so the register page can grab it
    localStorage.setItem("referral_prefill_email", email);

    // Redirect to register page
    nav("/referrals/register");
  }

  return (
    <div className="mt-12 bg-[#0a1324]/80 border border-indigo-500/30 rounded-2xl p-6 shadow-[0_0_30px_rgba(99,102,241,0.2)] backdrop-blur-md max-w-4xl mx-auto md:flex md:items-center md:justify-between md:gap-8">
      {/* Left Side: Text Content */}
      <div className="text-left mb-5 md:mb-0 md:flex-1">
        <h3 className="text-2xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-sky-300 to-indigo-300 drop-shadow-sm">
          Join the Program
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
          disabled={!email || !email.includes("@")}
          className="px-6 py-3 bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed rounded-xl font-bold text-white transition-all shadow-[0_0_20px_rgba(99,102,241,0.4)] hover:shadow-[0_0_30px_rgba(99,102,241,0.6)] whitespace-nowrap relative overflow-hidden"
        >
          <span className="relative z-10 drop-shadow">Get Started</span>
        </button>
      </div>
    </div>
  );
}
