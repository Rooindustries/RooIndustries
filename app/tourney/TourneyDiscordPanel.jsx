"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConnectedAccounts from "../../src/components/ConnectedAccounts";
import SupabaseSocialLogin from "../../src/components/SupabaseSocialLogin";

const LEGACY_STORAGE_KEY = "tourney_discord_verification";
const STATUS_COPY = Object.freeze({
  applied: "Discord is linked and your tournament role is applied.",
  pending: "Discord is linked. Your tournament role is pending.",
  retry: "Discord is linked. Role assignment will retry automatically.",
  blocked_reauth: "Reconnect Discord so Roo Industries can restore your tournament role.",
  dead_letter: "Discord role assignment needs a fresh connection before it can continue.",
  unlinked: "Connect the Discord account you will use for the tournament.",
  unavailable: "Discord role status is temporarily unavailable. Try again shortly.",
});

const normalizeState = (value) => Object.hasOwn(STATUS_COPY, value) ? value : "pending";

export default function TourneyDiscordPanel({ signedIn = false }) {
  const [state, setState] = useState(signedIn ? "pending" : "unlinked");

  useEffect(() => {
    sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (!signedIn) {
      setState("unlinked");
      return undefined;
    }

    let active = true;
    let timer;
    const scheduleReload = (callback) => {
      if (active) timer = window.setTimeout(callback, 5000);
    };
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/tourney/discord/status", { cache: "no-store" });
        const data = await response.json();
        if (!active) return;
        const reportedState = normalizeState(
          data?.discord?.state || (data?.discord?.linked ? "pending" : "unlinked")
        );
        const nextState = response.ok && data?.ok
          ? reportedState === "applied" && data?.discord?.roleAssigned !== true
            ? (data?.discord?.linked ? "pending" : "unlinked")
            : reportedState
          : "unavailable";
        setState(nextState);
        if (["pending", "retry", "unavailable"].includes(nextState)) {
          scheduleReload(loadStatus);
        }
      } catch {
        if (active) {
          setState("unavailable");
          scheduleReload(loadStatus);
        }
      }
    };
    loadStatus();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [signedIn]);

  if (!signedIn) {
    return (
      <div className="tourney-form tourney-form-narrow">
        <p className="tourney-form-message" role="status">
          Sign in to your approved Tourney account before connecting Discord.
        </p>
        <Link className="tourney-owner-button" href="/tourney/login?next=/tourney/discord">
          Sign in
        </Link>
      </div>
    );
  }

  const reconnect = ["unlinked", "blocked_reauth", "dead_letter"].includes(state);
  const requiresFreshCredentials = ["blocked_reauth", "dead_letter"].includes(state);
  return (
    <div className="tourney-form tourney-form-narrow" data-discord-state={state}>
      <p
        className={state === "applied" ? "tourney-form-message is-success" : "tourney-form-message"}
        role="status"
      >
        {STATUS_COPY[state]}
      </p>
      {reconnect ? (
        requiresFreshCredentials ? (
          <SupabaseSocialLogin
            action="reauth"
            flow="tourney"
            nextPath="/tourney"
            providerIds={["discord"]}
            reauthPurpose="link_identity"
            variant="tourney"
          />
        ) : (
          <ConnectedAccounts
            flow="tourney"
            nextPath="/tourney"
            providerIds={["discord"]}
            variant="tourney"
          />
        )
      ) : null}
    </div>
  );
}
