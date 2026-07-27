import React, { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SupabaseSocialLogin from "./SupabaseSocialLogin";
import SiteDialog from "./SiteDialog";

const PENDING_DISCORD_CHOICE_KEY = "refPendingDiscordChoice";
const PENDING_DISCORD_CHOICE_MAX_AGE_MS = 15 * 60 * 1000;
const LINK_PROVIDERS = ["discord", "google"];
const PROVIDER_LABELS = { discord: "Discord", google: "Google" };
const PASSWORD_UPDATED_MESSAGE =
  "Password updated. Log in with your new password.";

const normalizeProvider = (value) => {
  const provider = String(value || "").trim().toLowerCase();
  return LINK_PROVIDERS.includes(provider) ? provider : "discord";
};

const providerLabelOf = (value) => PROVIDER_LABELS[normalizeProvider(value)];

const linkSuccessMessage = (provider) =>
  `${providerLabelOf(provider)} linked to your account.`;

const linkFailedMessage = (provider) => {
  const label = providerLabelOf(provider);
  return `${label} linking did not complete. Try the ${label} login again.`;
};

const clearPendingDiscordChoice = () => {
  try {
    window.sessionStorage.removeItem(PENDING_DISCORD_CHOICE_KEY);
  } catch {
    console.error("Pending social link choice could not be cleared");
  }
};

const savePendingDiscordChoice = (state, provider = "discord") => {
  try {
    window.sessionStorage.setItem(
      PENDING_DISCORD_CHOICE_KEY,
      JSON.stringify({
        expiresAt: Date.now() + PENDING_DISCORD_CHOICE_MAX_AGE_MS,
        provider: normalizeProvider(provider),
        state,
      })
    );
  } catch {
    console.error("Pending social link choice could not be saved");
  }
};

// Returns { provider, state } so a choice saved before a redirect still knows
// which provider it belongs to. Choices written by an earlier deploy carry no
// provider and read back as Discord, which is what they were.
const readPendingDiscordChoice = () => {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(PENDING_DISCORD_CHOICE_KEY) || "null"
    );
    if (
      !["choose", "link"].includes(value?.state) ||
      Number(value?.expiresAt || 0) <= Date.now()
    ) {
      clearPendingDiscordChoice();
      return { provider: "", state: "" };
    }
    return { provider: normalizeProvider(value.provider), state: value.state };
  } catch {
    clearPendingDiscordChoice();
    return { provider: "", state: "" };
  }
};

export default function RefLogin() {
  const nav = useNavigate();
  const location = useLocation();

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [showUnlinkedDiscord, setShowUnlinkedDiscord] = useState(false);
  const [linkDiscord, setLinkDiscord] = useState(false);
  const [linkProvider, setLinkProvider] = useState("discord");
  const identifierInputRef = useRef(null);

  // Load saved referral code
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const oauthError = query.get("oauth");
    const provider = String(query.get("provider") || "").trim().toLowerCase();
    let pendingChoice = readPendingDiscordChoice();
    if (oauthError) {
      // Both providers are offered on this page, so both need somewhere to go
      // when the social account has no creator account linked yet.
      if (oauthError === "unlinked" && LINK_PROVIDERS.includes(provider)) {
        savePendingDiscordChoice("choose", provider);
        pendingChoice = { provider, state: "choose" };
        setLinkProvider(provider);
        setShowUnlinkedDiscord(true);
      } else {
        setOutcome({
          type: "error",
          message:
            oauthError === "unlinked"
            ? "That Google or Discord email is not linked to a creator account."
            : "Social sign-in is temporarily unavailable. Use your email or referral code.",
        });
      }
      query.delete("oauth");
      query.delete("provider");
    } else if (pendingChoice.state === "choose") {
      setLinkProvider(pendingChoice.provider);
      setShowUnlinkedDiscord(true);
    } else if (pendingChoice.state === "link") {
      setLinkProvider(pendingChoice.provider);
      setLinkDiscord(true);
    }

    if (query.get("notice") === "password-updated") {
      setOutcome({ type: "success", message: PASSWORD_UPDATED_MESSAGE });
      query.delete("notice");
    }
    const cleanSearch = query.toString();
    window.history.replaceState(
      null,
      "",
      `${location.pathname}${cleanSearch ? `?${cleanSearch}` : ""}`
    );

    const checkSession = async () => {
      if (pendingChoice.state) return;
      try {
        const sessionRes = await fetch("/api/ref/sessionStatus");
        if (sessionRes.ok) {
          const session = await sessionRes.json();
          if (!session?.authenticated) return;
          nav("/referrals/dashboard");
        }
      } catch {}
    };
    checkSession();

    const savedCode = sessionStorage.getItem("refLoginCode");
    if (savedCode) {
      setCode(savedCode);
      setRememberMe(true);
    }
  }, [location.pathname, location.search, nav]);

  async function handleLogin(e) {
    e.preventDefault();

    if (!code || !password) {
      setOutcome({ type: "error", message: "Please fill in all fields." });
      return;
    }

    setLoading(true);
    setOutcome(null);

    try {
      const heldChoice = readPendingDiscordChoice();
      const shouldLinkSocial = linkDiscord || heldChoice.state === "link";
      const requestedProvider = normalizeProvider(
        heldChoice.state === "link" ? heldChoice.provider : linkProvider
      );
      const res = await fetch("/api/ref/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          linkDiscord: shouldLinkSocial,
          ...(shouldLinkSocial ? { linkProvider: requestedProvider } : {}),
          password,
          rememberMe,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setOutcome({
          type: "error",
          message: data.error || "Login could not be completed. Please try again.",
        });
        return;
      }

      sessionStorage.setItem("refLoginCode", data.code || code);
      if (shouldLinkSocial) {
        clearPendingDiscordChoice();
        const socialLinked = data.discordLinked === true;
        const linkedProvider = socialLinked
          ? normalizeProvider(data.linkedProvider || requestedProvider)
          : requestedProvider;
        const message = socialLinked
          ? linkSuccessMessage(linkedProvider)
          : data.discordLinkError || linkFailedMessage(requestedProvider);
        setOutcome({ type: socialLinked ? "success" : "error", message });
        setTimeout(
          () =>
            nav(
              `/referrals/dashboard?notice=${
                socialLinked
                  ? `${linkedProvider}-linked`
                  : `${requestedProvider}-link-failed`
              }`
            ),
          900
        );
        return;
      }

      setOutcome({ type: "success", message: "Login successful." });
      setTimeout(() => nav("/referrals/dashboard"), 500);
    } catch {
      console.error("Referral login failed");
      setOutcome({
        type: "error",
        message: "Login could not be completed. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="pt-5 pb-5 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Referral Creator Login
      </h1>

      <p className="text-ink-muted mt-3 text-center max-w-md text-base">
        Access your commission & discount dashboard and manage your referral
        settings.
      </p>

      {/* Bigger Form Card */}
      <form
        onSubmit={handleLogin}
        className="mt-12 w-full max-w-md
                  bg-surface-card backdrop-blur-xl
                  border border-line-input
                  shadow-[var(--shadow-card-glow)]
                  rounded-2xl p-8 space-y-7"
      >
        {/* Referral Code or Email */}
        <div>
          <label htmlFor="ref-login-identifier" className="text-accent text-sm font-semibold">
            Referral code or login email
          </label>
          <input
            id="ref-login-identifier"
            name="identifier"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Referral code or login email"
            ref={identifierInputRef}
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
        </div>

        {/* Password */}
        <div>
          <label htmlFor="ref-login-password" className="text-accent text-sm font-semibold">Password</label>
          <input
            id="ref-login-password"
            name="password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {/* Remember Me */}
        <div className="flex items-center justify-between mt-1">
          <label
            htmlFor="ref-login-remember"
            className="inline-flex items-center gap-2 cursor-pointer select-none"
          >
            <input
              id="ref-login-remember"
              name="rememberMe"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="peer sr-only"
            />
            <div
              aria-hidden="true"
              className={`w-4 h-4 rounded-[6px] border transition-all flex items-center justify-center
                peer-focus-visible:ring-2 peer-focus-visible:ring-info-border peer-focus-visible:ring-offset-2
                ${
                  rememberMe
                    ? "border-info-border bg-info shadow-info-soft"
                    : "border-line-input bg-canvas"
                }`}
            >
              {rememberMe && (
                <span className="block w-2 h-2 rounded-[4px] bg-white" />
              )}
            </div>
            <span className="text-xs text-ink-secondary">Remember me</span>
          </label>

          <button
            type="button"
            onClick={() => nav("/referrals/forgot")}
            className="text-xs text-accent opacity-80 hover:opacity-100"
          >
            Forgot your password?
          </button>
        </div>

        {/* Submit Button */}
        {outcome ? (
          <div
            aria-live="polite"
            className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
              outcome.type === "success"
                ? "border-success-border bg-success-soft text-success-text"
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
          className={`w-full mt-4 py-4 rounded-xl font-bold text-lg transition-all
            ${
              loading
                ? "bg-surface-input opacity-40 cursor-not-allowed"
                : "bg-accent-strong hover:bg-accent text-white shadow-glow-soft"
            }
          `}
        >
          {loading ? "Logging in..." : "Login"}
        </button>

        <SupabaseSocialLogin
          flow="referral"
          nextPath="/referrals/dashboard"
          variant="referral"
        />
      </form>

      {/* Register Button */}
      <div className="mt-4 flex flex-col items-center gap-2">
        <p className="text-xs text-ink-muted">
          Don&apos;t have a creator account yet?
        </p>
        <button
          type="button"
          onClick={() => nav("/referrals/register")}
          className="px-5 py-2 rounded-xl text-sm font-semibold bg-accent-strong hover:bg-accent text-white
                     shadow-glow-soft transition-all"
        >
          Create an account
        </button>
      </div>

      <SiteDialog
        ariaDescribedBy="unlinked-discord-description"
        ariaLabelledBy="unlinked-discord-title"
        dismissible={false}
        open={showUnlinkedDiscord}
      >
        <h2
          className="text-2xl font-bold text-info-text"
          id="unlinked-discord-title"
        >
          No account linked yet
        </h2>
        <p
          className="mt-3 text-sm leading-6 text-ink-secondary"
          id="unlinked-discord-description"
        >
          This {providerLabelOf(linkProvider)} isn&apos;t linked to a creator
          account yet. Already registered? Log in and we&apos;ll link your{" "}
          {providerLabelOf(linkProvider)} to it. New here? Create your account.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            className="w-full rounded-xl bg-accent-strong px-5 py-3 text-sm font-semibold text-white shadow-glow-soft transition hover:bg-accent"
            data-autofocus
            onClick={() => {
              savePendingDiscordChoice("link", linkProvider);
              setLinkDiscord(true);
              setShowUnlinkedDiscord(false);
              requestAnimationFrame(() => identifierInputRef.current?.focus());
            }}
            type="button"
          >
            Log in and link
          </button>
          <button
            className="w-full rounded-xl border border-line-input bg-surface-input px-5 py-3 text-sm font-semibold text-ink-secondary transition hover:border-info-border hover:bg-surface-hover"
            onClick={() => {
              clearPendingDiscordChoice();
              nav(
                `/referrals/register?oauth=ready&provider=${normalizeProvider(
                  linkProvider
                )}`
              );
            }}
            type="button"
          >
            Create account
          </button>
        </div>
      </SiteDialog>

    </section>
  );
}
