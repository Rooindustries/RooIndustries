import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { getSupabaseBrowserClient } from "../lib/supabaseBrowser";

const RESET_TOKEN_STORAGE_KEY = "referral_reset_token";
const PASSWORD_UPDATE_TIMEOUT_MS = 15_000;
const PASSWORD_PENDING_RETRY_MS = 2_000;
const PASSWORD_PENDING_ATTEMPTS = 3;
const PASSWORD_PENDING_MESSAGE =
  "Your password change is saving. It will finish in a moment.";
const PASSWORD_UPDATED_MESSAGE =
  "Password updated. Log in with your new password.";

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readLegacyResetToken = ({ hash }) => {
  if (typeof window === "undefined") return "";
  const fragmentToken = new URLSearchParams(
    String(hash || "").replace(/^#/, "")
  ).get("token");
  const token = String(
    fragmentToken ||
      window.sessionStorage.getItem(RESET_TOKEN_STORAGE_KEY) ||
      ""
  ).trim();
  if (token) window.sessionStorage.setItem(RESET_TOKEN_STORAGE_KEY, token);
  return token;
};

const establishRecoverySession = async ({ hash, search }) => {
  const fragment = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const query = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const accessToken = String(fragment.get("access_token") || "").trim();
  const refreshToken = String(fragment.get("refresh_token") || "").trim();
  const code = String(query.get("code") || "").trim();
  const tokenHash = String(query.get("token_hash") || "").trim();
  const type = String(fragment.get("type") || query.get("type") || "").trim();
  const client = getSupabaseBrowserClient();

  if (type === "recovery" && accessToken && refreshToken) {
    return client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }
  if (code) return client.auth.exchangeCodeForSession(code);
  if (type === "recovery" && tokenHash) {
    return client.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
  }
  return { data: null, error: new Error("Recovery credentials are missing.") };
};

export default function RefReset() {
  const nav = useNavigate();
  const location = useLocation();
  const [recoveryLocation] = useState(() => ({
    hash:
      (typeof window !== "undefined" ? window.location.hash : "") ||
      location.hash ||
      "",
    pathname: location.pathname,
    search:
      (typeof window !== "undefined" ? window.location.search : "") ||
      location.search ||
      "",
  }));
  const [legacyToken, setLegacyToken] = useState("");
  const [mode, setMode] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      const token = readLegacyResetToken(recoveryLocation);
      if (token) {
        if (!cancelled) {
          setLegacyToken(token);
          setMode("legacy");
          setTokenReady(true);
        }
        window.history.replaceState(null, "", recoveryLocation.pathname);
        return;
      }

      try {
        const result = await establishRecoverySession(recoveryLocation);
        if (result.error || !result.data?.session) {
          throw result.error || new Error("Recovery session was not established.");
        }
        if (!cancelled) setMode("supabase");
      } catch {
        if (!cancelled) {
          setLinkError("This recovery link is invalid or expired. Request a new link.");
        }
      } finally {
        window.history.replaceState(null, "", recoveryLocation.pathname);
        if (!cancelled) setTokenReady(true);
      }
    };

    initialize();
    return () => {
      cancelled = true;
    };
  }, [recoveryLocation]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!pass1 || !pass2) {
      setOutcome({ type: "error", message: "Fill in both fields." });
      return;
    }
    if (pass1 !== pass2) {
      setOutcome({ type: "error", message: "Passwords do not match." });
      return;
    }
    if (pass1.length < 10 || pass1.length > 128) {
      setOutcome({
        type: "error",
        message: "Use a password between 10 and 128 characters.",
      });
      return;
    }

    setLoading(true);
    setOutcome(null);
    try {
      const endpoint = mode === "supabase" ? "recoverPassword" : "reset";
      const body =
        mode === "supabase"
          ? { password: pass1 }
          : { token: legacyToken, password: pass1 };
      for (let attempt = 0; attempt < PASSWORD_PENDING_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          PASSWORD_UPDATE_TIMEOUT_MS
        );
        let response;
        let data;
        try {
          response = await fetch(`/api/ref/${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          data = await response.json().catch(() => ({}));
        } finally {
          clearTimeout(timeout);
        }

        if (response.status === 202 || data.status === "pending") {
          setOutcome({
            type: "pending",
            message: data.message || PASSWORD_PENDING_MESSAGE,
          });
          if (attempt < PASSWORD_PENDING_ATTEMPTS - 1) {
            await wait(PASSWORD_PENDING_RETRY_MS);
            continue;
          }
          return;
        }
        if (!response.ok || !data.ok) {
          setOutcome({
            type: "error",
            message:
              data.error ||
              "Password update could not be completed. Please try again.",
          });
          return;
        }

        window.sessionStorage.removeItem(RESET_TOKEN_STORAGE_KEY);
        setOutcome({ type: "success", message: PASSWORD_UPDATED_MESSAGE });
        setTimeout(
          () => nav("/referrals/login?notice=password-updated"),
          1500
        );
        return;
      }
    } catch (error) {
      console.error("Referral password reset failed");
      setOutcome({
        type: "error",
        message:
          error?.name === "AbortError"
            ? "Password update took too long. Please try again."
            : "Password update could not be completed. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  };

  if (!tokenReady) return null;

  if (!mode) {
    return (
      <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
        <h1 className="text-3xl font-bold text-danger-text">Invalid Link</h1>
        <p className="text-ink-muted mt-2">
          {linkError || "This password reset link is missing recovery credentials."}
        </p>
        <button
          onClick={() => nav("/referrals/login")}
          className="mt-6 px-6 py-3 rounded-xl bg-accent-strong hover:bg-accent font-semibold text-accent-contrast"
          type="button"
        >
          Go to Login
        </button>
      </section>
    );
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Reset Password
      </h1>

      <form
        onSubmit={handleSubmit}
        className="mt-10 w-full max-w-md
                  bg-surface-card backdrop-blur-xl
                  border border-line-input
                  shadow-[var(--shadow-card-glow)]
                  rounded-2xl p-8 space-y-6"
      >
        <div>
          <label
            htmlFor="ref-reset-new-password"
            className="text-accent text-sm font-semibold"
          >
            New Password
          </label>
          <input
            id="ref-reset-new-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="Enter new password"
            value={pass1}
            onChange={(event) => setPass1(event.target.value)}
          />
        </div>

        <div>
          <label
            htmlFor="ref-reset-confirm-password"
            className="text-accent text-sm font-semibold"
          >
            Confirm Password
          </label>
          <input
            id="ref-reset-confirm-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="Confirm new password"
            value={pass2}
            onChange={(event) => setPass2(event.target.value)}
          />
        </div>

        {outcome ? (
          <div
            aria-live="polite"
            className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
              outcome.type === "success"
                ? "border-success-border bg-success-soft text-success-text"
                : outcome.type === "pending"
                  ? "border-warning-border bg-warning-soft text-warning-text"
                  : "border-danger-border bg-danger-soft text-danger-text"
            }`}
            role={outcome.type === "error" ? "alert" : "status"}
          >
            {outcome.message}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all ${
            loading
              ? "bg-surface-input opacity-40 cursor-not-allowed"
              : "bg-accent-strong hover:bg-accent text-accent-contrast shadow-glow-soft"
          }`}
        >
          {loading ? "Updating..." : "Update Password"}
        </button>
      </form>

    </section>
  );
}
