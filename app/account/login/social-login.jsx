"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabaseBrowser";
import styles from "../account.module.css";

const providers = [
  { id: "google", label: "Continue with Google" },
  { id: "discord", label: "Continue with Discord" },
];

export default function SocialLogin({ nextPath }) {
  const [busyProvider, setBusyProvider] = useState("");
  const [message, setMessage] = useState("");

  const signIn = async (provider) => {
    setBusyProvider(provider);
    setMessage("");

    try {
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", nextPath || "/account");
      const client = getSupabaseBrowserClient();
      const { error } = await client.auth.signInWithOAuth({
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
    <div className={styles.actions}>
      {providers.map((provider) => (
        <button
          className={`${styles.providerButton} ${styles[provider.id]}`}
          disabled={Boolean(busyProvider)}
          key={provider.id}
          onClick={() => signIn(provider.id)}
          type="button"
        >
          <span aria-hidden="true" className={styles.providerMark}>
            {provider.id === "google" ? "G" : "D"}
          </span>
          {busyProvider === provider.id ? "Opening sign-in…" : provider.label}
        </button>
      ))}
      {message ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
