"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SupabaseSocialLogin from "../../src/components/SupabaseSocialLogin";

const LEGACY_STORAGE_KEY = "tourney_discord_verification";

export default function TourneyDiscordPanel({ signedIn = false }) {
  const [linked, setLinked] = useState(false);

  useEffect(() => {
    sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (!signedIn) return;
    fetch("/api/auth/identities?flow=tourney", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setLinked(Boolean(data?.providers?.includes("discord"))))
      .catch(() => {});
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

  return (
    <div className="tourney-form tourney-form-narrow">
      <p className={linked ? "tourney-form-message is-success" : "tourney-form-message"}>
        {linked
          ? "Discord is linked to this Tourney account."
          : "Connect the Discord account you will use for the tournament."}
      </p>
      {!linked ? (
        <SupabaseSocialLogin
          action="link"
          flow="tourney"
          nextPath="/tourney"
          providerIds={["discord"]}
          variant="tourney"
        />
      ) : null}
    </div>
  );
}
