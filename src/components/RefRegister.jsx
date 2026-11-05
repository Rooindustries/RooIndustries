import { removeBrowserStorage, writeBrowserStorage } from "../lib/browserStorage";
import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import SupabaseSocialLogin from "./SupabaseSocialLogin";
import { isValidNewPassword, NEW_PASSWORD_REQUIREMENT } from "../lib/passwordPolicy";
import { requestDeadline } from "../lib/clientRequest";

const REFERRAL_SIGNUP_DRAFT = "referral_signup_draft";
const REGISTRATION_UNCERTAIN_MESSAGE =
  "We couldn't tell if your account was created. Check your email for a confirmation link before trying again.";

export const resolveReferralCodeAvailability = (response, data) => {
  if (!response?.ok) return null;
  if (data?.reason === "available") return true;
  if (data?.ok || data?.reason === "reserved") return false;
  return null;
};

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
  const [formError, setFormError] = useState("");
  const [socialIdentity, setSocialIdentity] = useState(null);
  const [identityCheckFailed, setIdentityCheckFailed] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const availabilityVersion = useRef(0);
  const submittingRef = useRef(false);
  const editVersionRef = useRef(0);
  const redirectTimerRef = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(redirectTimerRef.current);
    };
  }, []);

  function showToast(type, message) {
    const next = { type, message };
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 2800);
  }
  const loadSocialIdentity = () => {
    setIdentityCheckFailed(false);
    fetch("/api/auth/identities?flow=referral", { cache: "no-store", signal: requestDeadline() })
      .then((response) => {
        if (!response.ok) throw new Error("identity_check_failed");
        return response.json();
      })
      .then((data) => {
        if (data?.authenticated && data?.emailVerified && data.email) {
          setEmail(data.email);
          setPassword("");
          setConfirm("");
          setSocialIdentity(data);
        }
      })
      .catch(() => {
        if (mountedRef.current) setIdentityCheckFailed(true);
      });
  };

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
      removeBrowserStorage("sessionStorage", REFERRAL_SIGNUP_DRAFT);
    }
    loadSocialIdentity();
  }, []);

  const saveDraft = () => {
    writeBrowserStorage(
      "sessionStorage", REFERRAL_SIGNUP_DRAFT,
      JSON.stringify({ discordUsername, email, paypalEmail, slug })
    );
  };
  useEffect(() => {
    const version = ++availabilityVersion.current;
    setSlugAvailable(null);
    if (!slug) return undefined;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/ref/validateReferral?code=${encodeURIComponent(
            slug.toLowerCase()
          )}&purpose=registration`,
          { signal: controller.signal }
        );
        const data = await res.json();
        if (active && version === availabilityVersion.current) setSlugAvailable(resolveReferralCodeAvailability(res, data));
      } catch (err) {
        // network or server error: we don't assume taken
        if (active && version === availabilityVersion.current) setSlugAvailable(null);
      }
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug]);

  async function handleRegister(e) {
    e.preventDefault();
    if (submittingRef.current) return;
    setFormError("");

    const trimmedDiscordUsername = discordUsername.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPaypalEmail = paypalEmail.trim().toLowerCase();
    const trimmedSlug = slug.trim().toLowerCase();

    if (
      !trimmedDiscordUsername ||
      !trimmedEmail ||
      !trimmedPaypalEmail ||
      !trimmedSlug ||
      (!socialIdentity && !password) ||
      (!socialIdentity && !confirm)
    ) {
      setFormError("Please fill in all fields.");
      return;
    }

    const emailRegex = /\S+@\S+\.\S+/;
    if (!emailRegex.test(trimmedEmail)) {
      setFormError("Please enter a valid login email address.");
      return;
    }

    if (!emailRegex.test(trimmedPaypalEmail)) {
      setFormError("Please enter a valid PayPal email address.");
      return;
    }

    if (!socialIdentity && password !== confirm) {
      setFormError("Passwords do not match.");
      return;
    }

    if ((!socialIdentity || password) && !isValidNewPassword(password)) {
      setFormError(NEW_PASSWORD_REQUIREMENT);
      return;
    }

    if (slugAvailable === false) {
      setFormError("Referral code is already taken.");
      return;
    }
    const version = editVersionRef.current;
    submittingRef.current = true;
    setLoading(true);
    let redirecting = false;
    let registrationSent = false;
    try {
      if (slugAvailable === null) {
        try {
          const resCheck = await fetch(
            `/api/ref/validateReferral?code=${encodeURIComponent(
              trimmedSlug
            )}&purpose=registration`,
            { signal: requestDeadline() }
          );
          const dataCheck = await resCheck.json();
          const availability = resolveReferralCodeAvailability(
            resCheck,
            dataCheck
          );
          if (availability === false) {
            if (editVersionRef.current === version) {
              setSlugAvailable(false);
              setFormError("Referral code is already taken.");
            }
            return;
          } else if (availability === true) {
            if (editVersionRef.current === version) setSlugAvailable(true);
          } else {
            if (editVersionRef.current === version) setFormError("Could not validate referral code. Try again.");
            return;
          }
        } catch (err) {
          if (editVersionRef.current === version) setFormError("Could not validate referral code. Try again.");
          return;
        }
      }
      registrationSent = true;
      const res = await fetch("/api/ref/register", {
        method: "POST",
        signal: requestDeadline(15000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedDiscordUsername,
          discordUsername: trimmedDiscordUsername,
          contactDiscord: trimmedDiscordUsername,
          email: trimmedEmail,
          paypalEmail: trimmedPaypalEmail,
          slug: trimmedSlug,
          password,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (res.status === 409) {
          availabilityVersion.current += 1;
          setSlugAvailable(null);
        }
        if (editVersionRef.current === version) setFormError(data.error || "Registration failed.");
        return;
      }

      if (data.pendingVerification) {
        removeBrowserStorage("sessionStorage", REFERRAL_SIGNUP_DRAFT);
        setPassword("");
        setConfirm("");
        setVerificationPending(true);
        showToast("success", "Check your email to finish creating the account.");
        return;
      }

      removeBrowserStorage("sessionStorage", REFERRAL_SIGNUP_DRAFT);
      if (!mountedRef.current) return;
      redirecting = true;
      showToast("success", "Registered! Redirecting to dashboard...");
      redirectTimerRef.current = setTimeout(() => nav("/referrals/dashboard"), 900);
    } catch {
      console.error("Referral registration failed");
      if (registrationSent) setFormError(REGISTRATION_UNCERTAIN_MESSAGE);
      else if (editVersionRef.current === version) setFormError("Server error.");
    } finally {
      if (!redirecting) {
        submittingRef.current = false;
        setLoading(false);
      }
    }
  }

  return (
    <section className="pt-32 px-6 pb-20 min-h-screen text-ink flex flex-col items-center">
      <h1 className="section-title text-center">
        Referral Creator Registration
      </h1>
      <p className="section-lede text-center">
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

        <div>
          <label htmlFor="ref-register-discord" className="text-accent text-sm font-semibold">
            Discord Username
          </label>
          <input
            id="ref-register-discord"
            name="discordUsername"
            value={discordUsername}
            onChange={(e) => {
              setFormError("");
              editVersionRef.current += 1;
              setDiscordUsername(e.target.value);
            }}
            placeholder="e.g. @serviroo"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
          <p className="text-ink-muted text-xs mt-1">
            Use your Discord username. Real name is not required.
          </p>
        </div>

        <div>
          <label htmlFor="ref-register-email" className="text-accent text-sm font-semibold">
            Login Email
          </label>
          <input
            id="ref-register-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => {
              setFormError("");
              editVersionRef.current += 1;
              setEmail(e.target.value);
            }}
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
        {identityCheckFailed && !socialIdentity ? (
          <p
            role="alert"
            className="rounded-xl border border-line-input bg-surface-input px-4 py-3 text-sm text-ink-secondary"
          >
            We couldn't check your Google or Discord sign-in.{" "}
            <button type="button" onClick={loadSocialIdentity} className="font-semibold text-accent underline">
              Try again
            </button>
          </p>
        ) : null}

        <div>
          <label htmlFor="ref-register-paypal" className="text-accent text-sm font-semibold">
            PayPal Email (for payouts)
          </label>
          <input
            id="ref-register-paypal"
            name="paypalEmail"
            type="email"
            value={paypalEmail}
            onChange={(e) => {
              setFormError("");
              editVersionRef.current += 1;
              setPaypalEmail(e.target.value);
            }}
            placeholder="Email used for your PayPal account"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
          <p className="text-ink-muted text-xs mt-1">
            We’ll send your commissions to this PayPal address.
          </p>
        </div>

        <div>
          <label htmlFor="ref-register-slug" className="text-accent text-sm font-semibold">
            Referral Code
          </label>
          <input
            id="ref-register-slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setFormError("");
              editVersionRef.current += 1;
              setSlug(e.target.value);
            }}
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

        {!socialIdentity ? <div>
          <label htmlFor="ref-register-password" className="text-accent text-sm font-semibold">Password</label>
          <input
            id="ref-register-password"
            name="password"
            type="password"
            minLength={10}
            aria-describedby="ref-register-password-requirement"
            value={password}
            onChange={(e) => {
              setFormError("");
              editVersionRef.current += 1;
              setPassword(e.target.value);
            }}
            placeholder="Enter password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
          <p id="ref-register-password-requirement" className="mt-2 text-xs text-ink-muted">
            {NEW_PASSWORD_REQUIREMENT}
          </p>
        </div> : null}

        {!socialIdentity ? <div>
          <label htmlFor="ref-register-confirm" className="text-accent text-sm font-semibold">
            Confirm Password
          </label>
          <input
            id="ref-register-confirm"
            name="confirmPassword"
            type="password"
            value={confirm}
            onChange={(e) => {
              setFormError("");
              editVersionRef.current += 1;
              setConfirm(e.target.value);
            }}
            placeholder="Confirm password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl outline-none focus:border-info-border transition text-base"
          />
        </div> : null}

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
        {formError && (
          <p role="alert" aria-live="assertive" aria-atomic="true" className="text-sm text-danger-text">{formError}</p>
        )}
      </form>

      {toast && (
        <div
          role={toast.type === "error" ? "alert" : "status"}
          aria-live={toast.type === "error" ? "assertive" : "polite"}
          aria-atomic="true"
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-black text-sm font-semibold shadow-lg transition-all ${
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
