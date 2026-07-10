"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "tourney_registration_decision";

const readDecisionIntent = () => {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fromFragment = {
    token: String(fragment.get("token") || "").trim(),
    decision: String(fragment.get("decision") || "").trim().toLowerCase(),
    role: String(fragment.get("role") || "").trim(),
  };
  if (fromFragment.token) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromFragment));
  }
  if (window.location.hash) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  if (fromFragment.token) return fromFragment;
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") || {};
  } catch {
    return {};
  }
};

export default function TourneyDecisionPanel() {
  const started = useRef(false);
  const [result, setResult] = useState({
    loading: true,
    title: "Checking link",
    message: "Verifying this registration decision.",
    signInUrl: "",
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const intent = readDecisionIntent();
    if (!intent.token || !["approve", "deny"].includes(intent.decision)) {
      setResult({
        loading: false,
        title: "Invalid link",
        message: "This approval link is missing required details.",
        signInUrl: "",
      });
      return;
    }

    fetch("/api/tourney/registration-decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent),
    })
      .then(async (response) => ({
        response,
        data: await response.json().catch(() => ({})),
      }))
      .then(({ response, data }) => {
        if (response.ok && data.ok === true) {
          sessionStorage.removeItem(STORAGE_KEY);
        } else if (response.status !== 401 && response.status < 500) {
          sessionStorage.removeItem(STORAGE_KEY);
        }
        setResult({
          loading: false,
          title: data.title || (response.ok ? "Updated" : "Decision failed"),
          message: data.message || "Unable to update this registration.",
          signInUrl: data.signInUrl || "",
        });
      })
      .catch(() => {
        setResult({
          loading: false,
          title: "Decision failed",
          message: "Unable to update this registration. Refresh to try again.",
          signInUrl: "",
        });
      });
  }, []);

  return (
    <div className="tourney-form tourney-form-narrow">
      <h2>{result.title}</h2>
      <p className="tourney-form-message" role="status">
        {result.message}
      </p>
      {!result.loading && result.signInUrl ? (
        <Link className="tourney-owner-button" href={result.signInUrl}>
          Sign in
        </Link>
      ) : null}
      {!result.loading && !result.signInUrl ? (
        <Link className="tourney-owner-button" href="/tourney/manage">
          Open Manage
        </Link>
      ) : null}
    </div>
  );
}
