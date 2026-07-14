"use client";

import { useEffect, useState } from "react";
import { tourneyMutationFetch, tourneyMutationSuccessMessage } from "./tourneyMutation";

export function TourneyForgotForm() {
  const [login, setLogin] = useState("");
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    setIsSuccess(false);
    setMessage("");

    try {
      const response = await tourneyMutationFetch("/api/tourney/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to send reset link.");
      }
      setIsSuccess(true);
      setMessage(tourneyMutationSuccessMessage(
        data,
        "If the account exists, a reset link was sent."
      ));
    } catch (error) {
      setIsSuccess(false);
      setMessage(error?.message || "Unable to send reset link.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <form className="tourney-form tourney-form-narrow" onSubmit={handleSubmit}>
      <label>
        Discord username or email
        <input
          type="text"
          autoComplete="username"
          required
          value={login}
          onChange={(event) => setLogin(event.target.value)}
        />
      </label>
      <button className="tourney-owner-button" type="submit" disabled={isBusy}>
        {isBusy ? "Sending..." : "Send reset link"}
      </button>
      {message ? (
        <p
          className={isSuccess ? "tourney-form-message is-success" : "tourney-form-message"}
          role={isSuccess ? "status" : "alert"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function TourneyResetForm() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const resetToken = String(fragment.get("token") || "").trim();
    setToken(resetToken);
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    setIsSuccess(false);
    setMessage("");

    try {
      const response = await tourneyMutationFetch("/api/tourney/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to reset password.");
      }
      setPassword("");
      setIsSuccess(true);
      setMessage(tourneyMutationSuccessMessage(
        data,
        "Password updated. You can log in now."
      ));
    } catch (error) {
      setIsSuccess(false);
      setMessage(error?.message || "Unable to reset password.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <form className="tourney-form tourney-form-narrow" onSubmit={handleSubmit}>
      {!token ? (
        <p className="tourney-form-message" role="status">
          Reset token missing. Request a new password reset link.
        </p>
      ) : null}
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button className="tourney-owner-button" type="submit" disabled={isBusy || !token}>
        {isBusy ? "Updating..." : "Update password"}
      </button>
      {message ? (
        <p
          className={isSuccess ? "tourney-form-message is-success" : "tourney-form-message"}
          role={isSuccess ? "status" : "alert"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
