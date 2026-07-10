"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "tourney_discord_verification";

const readToken = () => {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = String(fragment.get("token") || "").trim();
  if (token) sessionStorage.setItem(STORAGE_KEY, token);
  if (window.location.hash) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return token || sessionStorage.getItem(STORAGE_KEY) || "";
};

export default function TourneyDiscordPanel() {
  const started = useRef(false);
  const [message, setMessage] = useState("Preparing Discord verification.");
  const [signInUrl, setSignInUrl] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readToken();
    fetch("/api/tourney/discord/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => ({
        response,
        data: await response.json().catch(() => ({})),
      }))
      .then(({ response, data }) => {
        if (response.ok && data.ok === true && data.authorizeUrl) {
          sessionStorage.removeItem(STORAGE_KEY);
          window.location.assign(data.authorizeUrl);
          return;
        }
        setMessage(data.error || "Discord verification could not be started.");
        setSignInUrl(data.signInUrl || "");
      })
      .catch(() => setMessage("Discord verification could not be started."));
  }, []);

  return (
    <div className="tourney-form tourney-form-narrow">
      <p className="tourney-form-message" role="status">{message}</p>
      {signInUrl ? (
        <Link className="tourney-owner-button" href={signInUrl}>Sign in</Link>
      ) : null}
    </div>
  );
}
