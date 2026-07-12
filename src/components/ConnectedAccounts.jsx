"use client";

import { useEffect, useState } from "react";
import SupabaseSocialLogin from "./SupabaseSocialLogin";

const allProviders = ["google", "discord"];

export default function ConnectedAccounts({
  flow,
  nextPath,
  variant = "referral",
}) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let active = true;
    fetch(`/api/auth/identities?flow=${encodeURIComponent(flow)}`, {
      cache: "no-store",
    })
      .then(async (response) => ({
        ok: response.ok,
        data: await response.json().catch(() => ({})),
      }))
      .then(({ ok, data }) => {
        if (!active) return;
        setState(ok && data.ok ? { ...data, loading: false } : { loading: false });
      })
      .catch(() => active && setState({ loading: false }));
    return () => {
      active = false;
    };
  }, [flow]);

  if (state.loading || !state.domainAccount) return null;
  const linked = new Set(state.providers || []);
  const missing = allProviders.filter((provider) => !linked.has(provider));
  const isTourney = variant === "tourney";

  return (
    <section
      className={
        isTourney
          ? "tourney-connected-accounts"
          : "mt-6 w-full rounded-xl border border-line-input bg-surface-card p-5 shadow-glow-soft"
      }
      aria-labelledby={`${flow}-connections-title`}
    >
      <div className={isTourney ? "tourney-connected-copy" : "space-y-1"}>
        <h2
          className={isTourney ? undefined : "text-base font-semibold text-ink"}
          id={`${flow}-connections-title`}
        >
          Connected accounts
        </h2>
        <p className={isTourney ? undefined : "text-xs leading-5 text-ink-muted"}>
          Link Google or Discord so you can use either one to sign in.
        </p>
      </div>
      <div className={isTourney ? "tourney-connected-status" : "mt-3 flex flex-wrap gap-2"}>
        {allProviders.map((provider) => (
          <span
            className={
              isTourney
                ? linked.has(provider)
                  ? "is-linked"
                  : "is-unlinked"
                : linked.has(provider)
                  ? "rounded-full border border-success-border bg-success-soft px-3 py-1 text-xs font-semibold text-success-text"
                  : "rounded-full border border-line-input px-3 py-1 text-xs text-ink-muted"
            }
            key={provider}
          >
            {provider[0].toUpperCase() + provider.slice(1)}: {linked.has(provider) ? "Linked" : "Not linked"}
          </span>
        ))}
      </div>
      {missing.length > 0 ? (
        <SupabaseSocialLogin
          action="link"
          flow={flow}
          nextPath={nextPath}
          providerIds={missing}
          variant={variant}
        />
      ) : null}
    </section>
  );
}
