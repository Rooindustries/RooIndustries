import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import SupabaseSocialLogin from "./SupabaseSocialLogin";

const REFERRAL_SIGNUP_DRAFT = "referral_signup_draft";

export default function RefRegister() {
  const nav = useNavigate();

  const [discordUsername, setDiscordUsername] = useState("");
  const [email, setEmail] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [slug, setSlug] = useState("");
  const [slugAvailable, setSlugAvailable] = useState(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [socialIdentity, setSocialIdentity] = useState(null);
  const [verificationPending, setVerificationPending] = useState(false);

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2800);
  }
  useEffect(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(REFERRAL_SIGNUP_DRAFT) || "null");
      if (draft) {
        setDiscordUsername(String(draft.discordUsername || ""));
        setEmail(String(draft.email || ""));
        setPaypalEmail(String(draft.paypalEmail || ""));
        setSlug(String(draft.slug || ""));
      }
    } catch {
      sessionStorage.removeItem(REFERRAL_SIGNUP_DRAFT);
    }
    fetch("/api/auth/identities?flow=referral", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (data?.authenticated && data?.emailVerified && data.email) {
          setEmail(data.email);
          setSocialIdentity(data);
        }
      })
      .catch(() => {});
  }, []);

  const saveDraft = () => {
    sessionStorage.setItem(
      REFERRAL_SIGNUP_DRAFT,
      JSON.stringify({ discordUsername, email, paypalEmail, slug })
    );
  };
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
        // A real match means taken. Only an explicit 404 means available.
        if (res.ok && data.ok) setSlugAvailable(false);
        else if (res.status === 404) setSlugAvailable(true);
        else setSlugAvailable(null);
      } catch (err) {
        // network or server error: we don't assume taken
        setSlugAvailable(null);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [slug]);

  async function handleRegister(e) {
    e.preventDefault();

    const trimmedDiscordUsername = discordUsername.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPaypalEmail = paypalEmail.trim().toLowerCase();
    const trimmedSlug = slug.trim().toLowerCase();
    const trimmedPassword = password.trim();
    const trimmedConfirm = confirm.trim();

    // Basic validation
    if (
      !trimmedDiscordUsername ||
      !trimmedEmail ||
      !trimmedPaypalEmail ||
      !trimmedSlug ||
      (!socialIdentity && !trimmedPassword) ||
      (!socialIdentity && !trimmedConfirm)
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

    if (!socialIdentity && trimmedPassword !== trimmedConfirm) {
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
        if (dataCheck.ok) {
          setSlugAvailable(false);
          showToast("error", "Referral code is already taken.");
          return;
        } else if (resCheck.status === 404) {
          setSlugAvailable(true); // available
        } else {
          showToast("error", "Could not validate referral code. Try again.");
          return;
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
          name: trimmedDiscordUsername,
          discordUsername: trimmedDiscordUsername,
          contactDiscord: trimmedDiscordUsername,
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

      if (data.pendingVerification) {
        sessionStorage.removeItem(REFERRAL_SIGNUP_DRAFT);
        setPassword("");
        setConfirm("");
        setVerificationPending(true);
        showToast("success", "Check your email to finish creating the account.");
        setLoading(false);
        return;
      }

      showToast("success", "Registered! Redirecting to dashboard...");
      sessionStorage.removeItem(REFERRAL_SIGNUP_DRAFT);
      setTimeout(() => nav("/referrals/dashboard"), 900);
    } catch {
      console.error("Referral registration failed");
      showToast("error", "Server error.");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 pb-20 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Referral Creator Registration
      </h1>
      <p className="text-ink-muted mt-3 text-center max-w-md text-base">
        Create your referral account and start earning commissions.
      </p>

      {verificationPending ? (
        <div className="mt-8 w-full max-w-md rounded-2xl border border-success-border bg-success-soft p-5 text-center text-success-text">
          Check your email and use the confirmation link to finish creating your account.
        </div>
      ) : null}

      <form
        onSubmit={handleRegister}
        className="mt-12 w-full max-w-md
                  bg-panel backdrop-blur-xl
                  border border-line-input
                  shadow-[var(--shadow-card-glow)]
                  rounded-2xl p-8 space-y-7"
      >
        <SupabaseSocialLogin
          action="signup"
          flow="referral"
          nextPath="/referrals/register"
          onBeforeRedirect={saveDraft}
          variant="referral"
        />

        {/* Discord Username */}
        <div>
          <label htmlFor="ref-register-discord" className="text-accent text-sm font-semibold">
            Discord Username
          </label>
          <input
            id="ref-register-discord"
            name="discordUsername"
            value={discordUsername}
            onChange={(e) => setDiscordUsername(e.target.value)}
            placeholder="e.g. @serviroo"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
          <p className="text-ink-muted text-xs mt-1">
            Use your Discord username. Real name is not required.
          </p>
        </div>

        {/* Email */}
        <div>
          <label htmlFor="ref-register-email" className="text-accent text-sm font-semibold">
            Login Email
          </label>
          <input
            id="ref-register-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={Boolean(socialIdentity)}
            placeholder="Email you sign in with"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
        </div>

        {socialIdentity ? (
          <p className="rounded-xl border border-success-border bg-success-soft px-4 py-3 text-sm text-success-text">
            Verified as {socialIdentity.email}. You can use Google or Discord to sign in.
          </p>
        ) : null}

        {/* PayPal Email */}
        <div>
          <label htmlFor="ref-register-paypal" className="text-accent text-sm font-semibold">
            PayPal Email (for payouts)
          </label>
          <input
            id="ref-register-paypal"
            name="paypalEmail"
            type="email"
            value={paypalEmail}
            onChange={(e) => setPaypalEmail(e.target.value)}
            placeholder="Email used for your PayPal account"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
          <p className="text-ink-muted text-xs mt-1">
            We’ll send your commissions to this PayPal address.
          </p>
        </div>

        {/* Referral Code */}
        <div>
          <label htmlFor="ref-register-slug" className="text-accent text-sm font-semibold">
            Referral Code
          </label>
          <input
            id="ref-register-slug"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="Custom referral code (e.g. yourname)"
            className={`w-full p-4 mt-1 bg-surface-input border rounded-xl outline-none focus:border-info-border transition text-base ${
              slugAvailable === false ? "border-danger-border" : "border-line-input"
            }`}
          />
          {slugAvailable === false && (
            <p className="text-danger-text text-sm mt-1">
              This referral code is already taken.
            </p>
          )}
          {slugAvailable === true && slug && (
            <p className="text-success-text text-sm mt-1">
              Referral code is available.
            </p>
          )}
        </div>

        {/* Password */}
        {!socialIdentity ? <div>
          <label htmlFor="ref-register-password" className="text-accent text-sm font-semibold">Password</label>
          <input
            id="ref-register-password"
            name="password"
            type="password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
        </div> : null}

        {/* Confirm Password */}
        {!socialIdentity ? <div>
          <label htmlFor="ref-register-confirm" className="text-accent text-sm font-semibold">
            Confirm Password
          </label>
          <input
            id="ref-register-confirm"
            name="confirmPassword"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
        </div> : null}

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
