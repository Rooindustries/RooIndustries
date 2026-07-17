"use client";

import { useState } from "react";
import { FaDiscord } from "react-icons/fa";
import { FcGoogle } from "react-icons/fc";
import { getSupabaseBrowserClient } from "../lib/supabaseBrowser";

const providers = [
  { id: "google", label: "Google", Icon: FcGoogle },
  { id: "discord", label: "Discord", Icon: FaDiscord },
];

const referralStyles = {
  container: "space-y-3 pt-1",
  divider: "flex items-center gap-3",
  dividerLine: "h-px flex-1 bg-line-input",
  dividerLabel:
    "text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-ink-muted",
  buttonGroup: "grid grid-cols-1 gap-3 sm:grid-cols-2",
  button:
    "flex min-h-[52px] items-center justify-center gap-2.5 rounded-xl border border-line-input bg-surface-input px-4 text-sm font-semibold text-ink-secondary transition hover:border-info-border hover:bg-surface-hover disabled:cursor-wait disabled:opacity-50",
  icon: "h-5 w-5 shrink-0",
  discordIcon: "text-[#5865f2]",
  error: "text-center text-xs leading-5 text-danger-text",
  previewNote: "text-center text-xs leading-5 text-ink-muted",
};

const tourneyStyles = {
  container: "cs-social",
  divider: "cs-social-divider",
  dividerLine: "cs-social-divider-line",
  dividerLabel: "cs-social-divider-label",
  buttonGroup: "cs-social-buttons",
  button: "cs-social-button",
  icon: "cs-social-icon",
  discordIcon: "cs-social-discord-icon",
  error: "cs-social-error",
  previewNote: "cs-social-preview-note",
};

export default function SupabaseSocialLogin({
  action = "signin",
  flow,
  linkProof = null,
  nextPath,
  onBeforeRedirect,
  onProofConsumed,
  onProofFailure,
  providerIds = ["google", "discord"],
  reauthPurpose = "",
  variant = "referral",
}) {
  const [busyProvider, setBusyProvider] = useState("");
  const [message, setMessage] = useState("");
  const styles = variant === "tourney" ? tourneyStyles : referralStyles;
  const visibleProviders = providers.filter(({ id }) => providerIds.includes(id));
  const socialAuthEnabled = ["1", "true", "yes", "on"].includes(
    String(process.env.NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED || "")
      .trim()
      .toLowerCase()
  );
  const previewOnly =
    flow === "tourney" &&
    !socialAuthEnabled &&
    ["1", "true", "yes", "on"].includes(
      String(process.env.NEXT_PUBLIC_TOURNEY_PREVIEW_OAUTH_MOCK || "")
        .trim()
        .toLowerCase()
    );

  const actionCopy = {
    link: { button: "Link", divider: "or link an account", error: "Account linking" },
    reclaim: { button: "Recover", divider: "recover the blocked account", error: "Account recovery" },
    reauth: { button: "Reauthenticate with", divider: "or reauthenticate with", error: "Reauthentication" },
    signup: { button: "Sign up with", divider: "or sign up with", error: "Sign-up" },
    signin: { button: "Continue with", divider: "or continue with", error: "Sign-in" },
  }[action] || { button: "Continue with", divider: "or continue with", error: "Sign-in" };
  const requiresLinkProof = ["link", "reclaim"].includes(action);
  const proofExpiresAt = Date.parse(String(linkProof?.expiresAt || ""));
  const hasLinkProof =
    linkProof?.confirmed === true &&
    Number.isFinite(proofExpiresAt) &&
    proofExpiresAt > Date.now();

  const start = async (provider) => {
    if (requiresLinkProof && !hasLinkProof) {
      setMessage("Confirm your identity before linking a provider.");
      onProofFailure?.();
      return;
    }
    setBusyProvider(provider);
    setMessage("");

    try {
      onBeforeRedirect?.();
      const client = getSupabaseBrowserClient();
      if (!["link", "reauth", "reclaim"].includes(action)) {
        await client.auth.signOut({ scope: "local" }).catch(() => {});
      }
      const intentResponse = await fetch("/api/auth/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          flow,
          provider,
          ...(reauthPurpose ? { reauthPurpose } : {}),
          returnPath: nextPath,
        }),
      });
      const intent = await intentResponse.json().catch(() => ({}));
      if (!intentResponse.ok || intent.ok !== true || !intent.callbackUrl) {
        throw new Error(intent.error || "OAuth intent failed");
      }
      if (requiresLinkProof) onProofConsumed?.();
      const options = {
        redirectTo: intent.callbackUrl,
        ...(provider === "discord"
          ? {
              scopes: flow === "tourney"
                ? "identify email guilds.join"
                : "identify email",
            }
          : {}),
      };
      const method = action === "link" ? "linkIdentity" : "signInWithOAuth";
      const { error } = await client.auth[method]({
        provider,
        options,
      });
      if (error) throw error;
    } catch {
      if (requiresLinkProof) onProofFailure?.();
      setMessage(`${actionCopy.error} could not be started. Please try again.`);
      setBusyProvider("");
    }
  };

  if ((!socialAuthEnabled && !previewOnly) || visibleProviders.length === 0) return null;

  return (
    <div className={styles.container}>
      <div className={styles.divider} aria-hidden="true">
        <span className={styles.dividerLine} />
        <span className={styles.dividerLabel}>{actionCopy.divider}</span>
        <span className={styles.dividerLine} />
      </div>
      <div className={styles.buttonGroup}>
        {visibleProviders.map(({ id, label, Icon }) => (
          <button
            aria-label={`${actionCopy.button} ${label}`}
            className={styles.button}
            disabled={
              previewOnly ||
              Boolean(busyProvider) ||
              (requiresLinkProof && !hasLinkProof)
            }
            key={id}
            onClick={() => start(id)}
            type="button"
          >
            <Icon
              aria-hidden="true"
              className={`${styles.icon} ${id === "discord" ? styles.discordIcon : ""}`}
            />
            <span>
              {busyProvider === id ? "Opening…" : `${actionCopy.button} ${label}`}
            </span>
          </button>
        ))}
      </div>
      {previewOnly ? (
        <p className={styles.previewNote}>
          Preview only. Google and Discord sign-in are disabled here.
        </p>
      ) : null}
      {message ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
