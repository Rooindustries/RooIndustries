import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getPublicContent } from "../lib/publicContentClient";

const normalizeReferralLoginPath = (path) =>
  !path || path === "/login" ? "/referrals/login" : path;

export default function ReferralBox() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");

  const [content, setContent] = useState({
    heading: "Join the Referral Program",
    description:
      "Are you a creator? Enter your email to get started with registration.",
    emailPlaceholder: "Enter your email...",
    startButtonText: "Get Started",
    loginButtonText: "Login",
    loginPath: "/referrals/login",
    registerPath: "/referrals/register",
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchContent() {
      try {
        const data = await getPublicContent("referral-box");

        if (!cancelled && data) {
          setContent((prev) => ({
            ...prev,
            ...Object.fromEntries(
              Object.entries(data).filter(
                ([, v]) => v !== undefined && v !== null
              )
            ),
          }));
        }
      } catch {
        // keep fallbacks
      }
    }

    fetchContent();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleStart() {
    if (!email || !email.includes("@")) return;

    sessionStorage.setItem("referral_prefill_email", email);
    nav(content.registerPath || "/referrals/register");
  }

  function handleLogin() {
    nav(normalizeReferralLoginPath(content.loginPath));
  }

  const isValid = !!email && email.includes("@");

  return (
    <div className="mt-12 mb-8 bg-surface-card border border-line-accent rounded-2xl p-6 shadow-[var(--shadow-referral-glow)] backdrop-blur-md max-w-4xl mx-auto md:flex md:items-center md:justify-between md:gap-8">
      {/* Left Side: Text Content */}
      <div className="text-left mb-5 md:mb-0 md:flex-1">
        <h3 className="text-2xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-strong drop-shadow-sm">
          {content.heading}
        </h3>
        <p className="text-sm text-ink-secondary leading-relaxed">
          {content.description}
        </p>
      </div>

      {/* Right Side: Input and Buttons */}
      <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto md:flex-initial sm:items-stretch">
        <input
          type="email"
          placeholder={content.emailPlaceholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 md:w-64 bg-surface-input border border-line-input focus:border-info-border rounded-xl px-4 py-3 text-sm text-ink-secondary outline-none transition-all placeholder:text-ink-muted shadow-inner"
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
            ring-1 ring-line-accent
            transition-all duration-300
            active:translate-y-px
            w-full sm:w-auto

            bg-gradient-to-r from-accent to-accent-strong
            hover:from-accent-strong hover:to-accent
            shadow-[var(--shadow-button-accent)]

            disabled:opacity-50 disabled:cursor-not-allowed
            disabled:hover:from-accent disabled:hover:to-accent-strong
          "
        >
          <span className="relative z-10 drop-shadow">
            {content.startButtonText}
          </span>

          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </button>

        <button
          onClick={handleLogin}
          className="
            inline-flex items-center justify-center
            rounded-xl
            px-4 sm:px-5 py-3
            text-sm font-semibold
            w-full sm:w-auto
            border border-line-accent
            bg-surface-input
            text-ink-secondary
            hover:border-line-accent
            hover:text-[color:var(--color-link-hover)]
            transition-all duration-300
            shadow-[var(--shadow-referral-glow)]
            active:translate-y-px
          "
        >
          {content.loginButtonText}
        </button>
      </div>
    </div>
  );
}
