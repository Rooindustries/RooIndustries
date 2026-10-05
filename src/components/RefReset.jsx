import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { runSupabaseBrowserRecovery } from "../lib/supabaseBrowser";
import { isValidNewPassword, NEW_PASSWORD_REQUIREMENT } from "../lib/passwordPolicy";

let recoveryInitialization = null;

const RESET_TOKEN_STORAGE_KEY = "referral_reset_token";
const RECOVERY_SESSION_STORAGE_KEY = "referral_recovery_session";
const RECOVERY_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;
const PASSWORD_UPDATE_TIMEOUT_MS = 15_000;
const PASSWORD_PENDING_RETRY_MS = 2_000;
const PASSWORD_PENDING_ATTEMPTS = 3;
const PASSWORD_PENDING_MESSAGE =
  "Your password change is saving. It will finish in a moment.";
const PASSWORD_UPDATED_MESSAGE =
  "Password updated. Log in with your new password.";

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readStoredRecovery = (key) => {
  try {
    return window.sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
};

const storeRecovery = (key, value) => {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {}
};

const recoveryParams = ({ hash, search }) => ({
  fragment: new URLSearchParams(String(hash || "").replace(/^#/, "")),
  query: new URLSearchParams(String(search || "").replace(/^\?/, "")),
});

const scrubRecoveryLocation = (location) => {
  if (window.location.pathname === location.pathname &&
    (!window.location.hash || window.location.hash === location.hash) &&
    (!window.location.search || window.location.search === location.search)) {
    const state = window.history.state;
    window.history.replaceState(null, "", location.pathname);
    window.history.replaceState(state, "", location.pathname);
  }
};

const hasSupabaseRecoveryLink = (location) => {
  const { fragment, query } = recoveryParams(location);
  return ["code", "token_hash", "access_token", "refresh_token", "error", "error_code"].some(
    (key) => fragment.has(key) || query.has(key)
  ) || fragment.get("type") === "recovery" || query.get("type") === "recovery";
};

const readLegacyResetToken = (location) => {
  const { fragment } = recoveryParams(location);
  const token = String(fragment.get("token") || readStoredRecovery(RESET_TOKEN_STORAGE_KEY)).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) return "";
  storeRecovery(RESET_TOKEN_STORAGE_KEY, token);
  return token;
};

const validateRecoverySession = async (client, session, marker) => {
  if (!session?.access_token || !session?.user?.id) throw new Error("Recovery session is missing.");
  const [userResult, claimsResult] = await Promise.all([
    client.auth.getUser(session.access_token),
    client.auth.getClaims(session.access_token),
  ]);
  const claims = claimsResult.data?.claims;
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = Number(claims?.iat);
  const expiresAt = Number(claims?.exp);
  const sessionId = String(claims?.session_id || "");
  const userId = userResult.data?.user?.id;
  const otp = (Array.isArray(claims?.amr) ? claims.amr : []).some((entry) => {
    const method = String(typeof entry === "string" ? entry : entry?.method).toLowerCase();
    const authenticatedAt = typeof entry === "string" ? issuedAt : Number(entry?.timestamp);
    return ["otp", "recovery"].includes(method) && Number.isFinite(authenticatedAt) &&
      authenticatedAt >= now - RECOVERY_SESSION_MAX_AGE_SECONDS && authenticatedAt <= now + 60;
  });
  if (userResult.error || claimsResult.error || !userId || !sessionId ||
    userId !== session.user.id || claims?.sub !== userId || !otp ||
    !Number.isFinite(issuedAt) || issuedAt < now - RECOVERY_SESSION_MAX_AGE_SECONDS || issuedAt > now + 60 ||
    !Number.isFinite(expiresAt) || expiresAt <= now ||
    (marker && (marker.userId !== userId || marker.sessionId !== sessionId))) {
    throw new Error("Recovery session is invalid or expired.");
  }
  return { userId, sessionId };
};

const establishRecoverySession = async (client, location, freshLink) => {
  const { fragment, query } = recoveryParams(location);
  const accessToken = String(fragment.get("access_token") || "").trim();
  const refreshToken = String(fragment.get("refresh_token") || "").trim();
  const code = String(query.get("code") || "").trim();
  const tokenHash = String(query.get("token_hash") || "").trim();
  const type = String(fragment.get("type") || query.get("type") || "").trim();
  let result;
  let marker;
  if (freshLink) {
    if (type === "recovery" && accessToken && refreshToken) {
      result = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    } else if (code) {
      result = await client.auth.exchangeCodeForSession(code);
    } else if (type === "recovery" && tokenHash) {
      result = await client.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    } else {
      throw new Error("Recovery credentials are missing.");
    }
  } else {
    marker = JSON.parse(readStoredRecovery(RECOVERY_SESSION_STORAGE_KEY) || "null");
    if (!marker?.userId || !marker?.sessionId) throw new Error("Recovery credentials are missing.");
    result = await client.auth.getSession();
  }
  if (result.error) throw result.error;
  const verified = await validateRecoverySession(client, result.data?.session, marker);
  return verified;
};

export default function RefReset() {
  const nav = useNavigate();
  const location = useLocation();
  const [recoveryLocation, setRecoveryLocation] = useState(() => {
    const candidate = {
      hash: (typeof window !== "undefined" ? window.location.hash : "") || location.hash || "",
      pathname: location.pathname,
      search: (typeof window !== "undefined" ? window.location.search : "") || location.search || "",
    };
    return (typeof window === "undefined" || window.location.pathname === candidate.pathname) &&
      !hasSupabaseRecoveryLink(candidate) && !recoveryParams(candidate).fragment.has("token") &&
      recoveryInitialization?.pending && recoveryInitialization.location.pathname === candidate.pathname
      ? recoveryInitialization.location : candidate;
  });
  const initialization = useRef(null);
  const linkKey = JSON.stringify([recoveryLocation.pathname, recoveryLocation.search, recoveryLocation.hash]);
  const activeLink = useRef(linkKey);
  const mounted = useRef(true);
  const [recoveryIdentity, setRecoveryIdentity] = useState(null);
  const [legacyToken, setLegacyToken] = useState("");
  const [mode, setMode] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        const entry = initialization.current;
        if (!mounted.current && entry?.owner === mounted) entry.controller.abort();
      });
    };
  }, []);

  useEffect(() => {
    const updateLocation = (event) => {
      const next = { pathname: window.location.pathname, hash: window.location.hash, search: window.location.search };
      const { fragment } = recoveryParams(next);
      if (next.pathname !== location.pathname || (!hasSupabaseRecoveryLink(next) && !fragment.has("token"))) return;
      event?.stopImmediatePropagation();
      const key = JSON.stringify([next.pathname, next.search, next.hash]);
      scrubRecoveryLocation(next);
      if (key === activeLink.current) return;
      if (hasSupabaseRecoveryLink(next)) {
        storeRecovery(RESET_TOKEN_STORAGE_KEY, "");
        storeRecovery(RECOVERY_SESSION_STORAGE_KEY, "");
      }
      initialization.current?.controller.abort();
      activeLink.current = key;
      setRecoveryLocation(next);
    };
    updateLocation();
    window.addEventListener("hashchange", updateLocation, true);
    window.addEventListener("popstate", updateLocation, true);
    return () => {
      window.removeEventListener("hashchange", updateLocation, true);
      window.removeEventListener("popstate", updateLocation, true);
    };
  }, [location.pathname, location.hash, location.search]);

  useEffect(() => {
    let cancelled = false;
    let resumedCompleted = false;
    activeLink.current = linkKey;
    if (initialization.current?.key !== linkKey) {
      const previous = recoveryInitialization;
      let marker;
      try { marker = JSON.parse(readStoredRecovery(RECOVERY_SESSION_STORAGE_KEY) || "null"); } catch {}
      const reused = previous?.key === linkKey && !previous.controller.signal.aborted &&
        (previous.pending || (previous.identity && marker?.userId === previous.identity.userId && marker?.sessionId === previous.identity.sessionId));
      resumedCompleted = reused && !previous.pending;
      const entry = reused ? previous : {
        key: linkKey, location: recoveryLocation, promise: null,
        controller: new AbortController(), pending: true, owner: mounted,
      };
      entry.owner = mounted;
      initialization.current = entry;
      const current = () => recoveryInitialization === entry && entry.owner.current;
      setTokenReady(false);
      setRecoveryIdentity(null);
      setLegacyToken("");
      setMode("");
      setLinkError("");
      setOutcome(null);
      setPass1("");
      setPass2("");
      setLoading(false);
      scrubRecoveryLocation(recoveryLocation);
      if (!reused) {
        previous?.controller.abort();
        recoveryInitialization = entry;
        entry.promise = (async () => {
          try {
            await previous?.promise;
            if (!current()) return null;
            const freshLink = hasSupabaseRecoveryLink(recoveryLocation);
            if (freshLink) {
              storeRecovery(RESET_TOKEN_STORAGE_KEY, "");
              storeRecovery(RECOVERY_SESSION_STORAGE_KEY, "");
            }
            const token = freshLink ? "" : readLegacyResetToken(recoveryLocation);
            if (token) {
              storeRecovery(RECOVERY_SESSION_STORAGE_KEY, "");
              return { mode: "legacy", token };
            }
            const identity = await runSupabaseBrowserRecovery(entry.controller.signal,
              client => establishRecoverySession(client, recoveryLocation, freshLink));
            if (!current()) return null;
            if (entry.controller.signal.aborted) throw new DOMException("Recovery request cancelled.", "AbortError");
            entry.identity = identity;
            storeRecovery(RECOVERY_SESSION_STORAGE_KEY, JSON.stringify(identity));
            return { mode: "supabase", token: "", identity };
          } catch (error) {
            if (!current()) return null;
            storeRecovery(RECOVERY_SESSION_STORAGE_KEY, "");
            return { mode: "", token: "", error: entry.controller.signal.aborted || error?.name === "TimeoutError"
              ? "Checking this recovery link took too long. Request a new recovery link and open it to retry."
              : "This recovery link is invalid or expired. Request a new link." };
          } finally {
            entry.pending = false;
          }
        })();
      }
      if (window.location.pathname === recoveryLocation.pathname &&
        (hasSupabaseRecoveryLink(location) || recoveryParams(location).fragment.has("token"))) {
        nav(recoveryLocation.pathname, { replace: true, state: location.state });
      }
    }
    const entry = initialization.current;
    entry.promise.then(async (result) => {
      if (cancelled || !result || initialization.current !== entry || activeLink.current !== entry.key) return;
      if (resumedCompleted && result.identity) {
        try {
          await runSupabaseBrowserRecovery(entry.controller.signal, async client => {
            const session = await client.auth.getSession();
            if (session.error) throw session.error;
            await validateRecoverySession(client, session.data?.session, result.identity);
          });
        } catch {
          if (cancelled || initialization.current !== entry || activeLink.current !== entry.key) return;
          storeRecovery(RECOVERY_SESSION_STORAGE_KEY, "");
          result = { mode: "", token: "", error: "This recovery session changed or expired. Request a new recovery link." };
        }
      }
      if (cancelled || initialization.current !== entry || activeLink.current !== entry.key) return;
      setRecoveryIdentity(result.identity || null);
      setLegacyToken(result.token);
      setMode(result.mode);
      setLinkError(result.error || "");
      setTokenReady(true);
    });
    return () => { cancelled = true; };
  }, [linkKey, recoveryLocation]);

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
    if (!isValidNewPassword(pass1)) {
      setOutcome({
        type: "error",
        message: NEW_PASSWORD_REQUIREMENT,
      });
      return;
    }

    const entry = initialization.current;
    const current = () => mounted.current && initialization.current === entry && activeLink.current === entry.key;
    if (!tokenReady || !mode || !current()) return;
    setLoading(true);
    setOutcome(null);
    try {
      const endpoint = mode === "supabase" ? "recoverPassword" : "reset";
      const body =
        mode === "supabase"
          ? { password: pass1, expectedUserId: recoveryIdentity.userId, expectedSessionId: recoveryIdentity.sessionId }
          : { token: legacyToken, password: pass1 };
      for (let attempt = 0; attempt < PASSWORD_PENDING_ATTEMPTS; attempt += 1) {
        if (!current()) return;
        if (mode === "supabase") {
          try {
            await runSupabaseBrowserRecovery(entry.controller.signal, async client => {
              const session = await client.auth.getSession();
              if (session.error || !recoveryIdentity) throw new Error("Recovery identity is missing.");
              await validateRecoverySession(client, session.data?.session, recoveryIdentity);
            });
          } catch (error) {
            if (!current()) return;
            setOutcome({ type: "error", message: error?.name === "TimeoutError"
              ? "Checking your recovery session took too long. Please try again."
              : "This recovery session changed or expired. Open your recovery link again." });
            return;
          }
        }
        if (!current()) return;
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

        if (!current()) return;
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

        storeRecovery(RESET_TOKEN_STORAGE_KEY, "");
        storeRecovery(RECOVERY_SESSION_STORAGE_KEY, "");
        setOutcome({ type: "success", message: PASSWORD_UPDATED_MESSAGE });
        setTimeout(
          () => { if (current()) nav("/referrals/login?notice=password-updated"); },
          1500
        );
        return;
      }
    } catch (error) {
      if (!current()) return;
      console.error("Referral password reset failed");
      setOutcome({
        type: "error",
        message:
          error?.name === "AbortError"
            ? "Password update took too long. Please try again."
            : "Password update could not be completed. Please try again.",
      });
    } finally {
      if (current()) setLoading(false);
    }
  };

  if (!tokenReady) return <p role="status" className="pt-32 px-6 text-center text-ink-muted">Checking your recovery link...</p>;

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
            aria-describedby="ref-reset-password-requirement"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="Enter new password"
            value={pass1}
            onChange={(event) => setPass1(event.target.value)}
          />
          <p id="ref-reset-password-requirement" className="mt-2 text-xs text-ink-muted">
            {NEW_PASSWORD_REQUIREMENT}
          </p>
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
