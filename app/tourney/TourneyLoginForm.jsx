"use client";

import { useState } from "react";

const errorMessage = (error) => {
  if (!error) return "";
  if (error === "rate") {
    return "Too many attempts. Please try again later.";
  }
  if (error === "suspended") {
    return "You have been suspended from the tourney. Please contact serviroo through Discord or at serviroo@rooindustries.com for further queries.";
  }
  if (error === "unlinked") {
    return "That Google or Discord email is not linked to an approved Tourney account. Use your username or email and password.";
  }
  if (["unavailable", "exchange_failed", "missing_code"].includes(error)) {
    return "Social sign-in is temporarily unavailable. Use your username or email and password.";
  }
  return "Invalid Discord username, email, or password. Wait for approval before trying to log in.";
};

export default function TourneyLoginForm({
  buttonLabel = "Sign in",
  initialError = "",
  navigate,
  note = "Assigned accounts only.",
  redirectTo = "/tourney",
  socialLogin = null,
}) {
  const [message, setMessage] = useState(errorMessage(initialError));
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;

    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/tourney/login", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: String(form.get("username") || ""),
          password: String(form.get("password") || ""),
          rememberMe: form.get("rememberMe") === "on",
          redirectTo,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        setMessage(
          result.error || "Sign in is temporarily unavailable. Please try again."
        );
        return;
      }
      if (typeof navigate === "function") {
        navigate(redirectTo);
      } else {
        window.location.assign(redirectTo);
      }
    } catch {
      setMessage("Sign in is temporarily unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="cs-login cs-r5" onSubmit={handleSubmit}>
        <input
          aria-label="Discord username or email"
          autoComplete="username"
          className="cs-field"
          name="username"
          placeholder="Discord username or email"
          required
          type="text"
        />
        <input
          aria-label="Password"
          autoComplete="current-password"
          className="cs-field"
          name="password"
          placeholder="Password"
          required
          type="password"
        />
        <label className="cs-remember">
          <input name="rememberMe" type="checkbox" value="on" />
          <span>Remember me</span>
        </label>
        <button className="cs-button" disabled={busy} type="submit">
          {busy ? "Signing in…" : buttonLabel}
        </button>
      </form>
      {socialLogin}
      {message ? (
        <p className="cs-error cs-r5" role="alert">
          {message}
        </p>
      ) : (
        <p className="cs-note cs-r5">{note}</p>
      )}
      <p className="cs-note cs-r5">
        <a href="/tourney/forgot">Forgot password?</a>
      </p>
    </>
  );
}
