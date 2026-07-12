"use client";

import { useState } from "react";
import { FaDiscord } from "react-icons/fa";
import { FcGoogle } from "react-icons/fc";
import { getSupabaseBrowserClient } from "../lib/supabaseBrowser";

const providers = [
  { id: "google", label: "Google", ariaLabel: "Continue with Google", Icon: FcGoogle },
  { id: "discord", label: "Discord", ariaLabel: "Continue with Discord", Icon: FaDiscord },
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
};

export default function SupabaseSocialLogin({
  flow,
  nextPath,
  variant = "referral",
}) {
  const [busyProvider, setBusyProvider] = useState("");
  const [message, setMessage] = useState("");
  const styles = variant === "tourney" ? tourneyStyles : referralStyles;

  const signIn = async (provider) => {
    setBusyProvider(provider);
    setMessage("");

    try {
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("flow", flow);
      callback.searchParams.set("next", nextPath);
      const { error } = await getSupabaseBrowserClient().auth.signInWithOAuth({
        provider,
        options: { redirectTo: callback.toString() },
      });
      if (error) throw error;
    } catch {
      setMessage("Sign-in could not be started. Please try again.");
      setBusyProvider("");
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.divider} aria-hidden="true">
        <span className={styles.dividerLine} />
        <span className={styles.dividerLabel}>or continue with</span>
        <span className={styles.dividerLine} />
      </div>
      <div className={styles.buttonGroup}>
        {providers.map(({ id, label, ariaLabel, Icon }) => (
          <button
            aria-label={ariaLabel}
            className={styles.button}
            disabled={Boolean(busyProvider)}
            key={id}
            onClick={() => signIn(id)}
            type="button"
          >
            <Icon
              aria-hidden="true"
              className={`${styles.icon} ${id === "discord" ? styles.discordIcon : ""}`}
            />
            <span>{busyProvider === id ? "Opening…" : label}</span>
          </button>
        ))}
      </div>
      {message ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
