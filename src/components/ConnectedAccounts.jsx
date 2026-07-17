"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SupabaseSocialLogin from "./SupabaseSocialLogin";

const allProviders = ["google", "discord"];

const validProof = (proof) => {
  const expiresAt = Date.parse(String(proof?.expiresAt || ""));
  return proof?.confirmed === true && Number.isFinite(expiresAt) && expiresAt > Date.now();
};

const proofExpiryLabel = (expiresAt) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(expiresAt));

export default function ConnectedAccounts({
  flow,
  nextPath,
  providerIds = allProviders,
  variant = "referral",
}) {
  const [state, setState] = useState({ loading: true });
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkProof, setLinkProof] = useState(null);
  const [syncingProvider, setSyncingProvider] = useState("");
  const proofExpiryTimer = useRef(null);
  const unlinkPollTimer = useRef(null);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const response = await fetch(
        `/api/auth/identities?flow=${encodeURIComponent(flow)}`,
        { cache: "no-store" }
      );
      const data = await response.json().catch(() => ({}));
      if (!mounted.current) return;
      if (response.ok && data.ok) {
        setState({ ...data, loading: false, error: "" });
        setLinkProof(validProof(data.linkProof) ? data.linkProof : null);
      } else {
        setState({
          loading: false,
          error: data.error || "Account connections are temporarily unavailable.",
        });
        setLinkProof(null);
      }
    } catch {
      if (mounted.current) {
        setState({
          loading: false,
          error: "Account connections are temporarily unavailable.",
        });
        setLinkProof(null);
      }
    }
  }, [flow]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
      if (unlinkPollTimer.current) clearTimeout(unlinkPollTimer.current);
      if (proofExpiryTimer.current) clearTimeout(proofExpiryTimer.current);
    };
  }, [load]);

  useEffect(() => {
    if (proofExpiryTimer.current) clearTimeout(proofExpiryTimer.current);
    if (!validProof(linkProof)) {
      if (linkProof) setLinkProof(null);
      return undefined;
    }
    const delay = Math.min(
      2_147_000_000,
      Math.max(0, Date.parse(linkProof.expiresAt) - Date.now())
    );
    proofExpiryTimer.current = setTimeout(() => {
      setLinkProof(null);
      setMessage("Identity confirmation expired. Confirm your identity again.");
    }, delay);
    return () => {
      if (proofExpiryTimer.current) clearTimeout(proofExpiryTimer.current);
    };
  }, [linkProof]);

  const managedProviders = allProviders.filter((provider) => providerIds.includes(provider));
  const isTourney = variant === "tourney";
  if (state.loading) return null;
  if (state.error) {
    return (
      <section
        aria-labelledby={`${flow}-connections-title`}
        className={
          isTourney
            ? "tourney-connected-accounts"
            : "mt-6 w-full rounded-xl border border-line-input bg-surface-card p-5 shadow-glow-soft"
        }
      >
        <h2 id={`${flow}-connections-title`}>Connected accounts</h2>
        <p className={isTourney ? "tourney-form-message" : "mt-3 text-xs text-danger-text"} role="alert">
          {state.error}
        </p>
        <button
          className={isTourney ? "tourney-owner-button" : "mt-3 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"}
          onClick={load}
          type="button"
        >
          Retry
        </button>
      </section>
    );
  }
  if (!state.domainAccount) return null;
  const linked = new Set(state.providers || []);
  const missing = managedProviders.filter((provider) => !linked.has(provider));
  const connectedSocial = managedProviders.filter((provider) => linked.has(provider));
  const recoveryProvider = missing.includes(state.recovery?.provider)
    ? state.recovery.provider
    : "";
  const standardMissing = missing.filter((provider) => provider !== recoveryProvider);
  const hasLinkProof = validProof(linkProof);
  const canUnlink = (state.unlinkableProviders || []).length > 1;
  const unlinkable = new Set(state.unlinkableProviders || []);

  const confirmPassword = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow,
          password,
          purpose: "link_identity",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to confirm your identity.");
      if (!data.expiresAt || Date.parse(data.expiresAt) <= Date.now()) {
        throw new Error("Identity confirmation did not return a valid expiry.");
      }
      setPassword("");
      setLinkProof({ confirmed: true, expiresAt: data.expiresAt });
      setMessage(
        `Identity confirmed until ${proofExpiryLabel(data.expiresAt)}. This proof allows one link attempt.`
      );
    } catch (error) {
      setLinkProof(null);
      setMessage(error.message || "Unable to confirm your identity.");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (provider) => {
    setBusy(true);
    setMessage("");
    try {
      if (linked.has("email") && !password) {
        throw new Error("Enter your current password, then select Unlink.");
      }
      if (password) {
        const reauthResponse = await fetch("/api/auth/reauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flow,
            password,
            provider,
            purpose: "unlink_identity",
          }),
        });
        const reauthData = await reauthResponse.json().catch(() => ({}));
        if (!reauthResponse.ok || !reauthData.ok) {
          throw new Error(reauthData.error || "Unable to confirm your identity.");
        }
      }
      const response = await fetch("/api/auth/identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow, provider }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to unlink this account.");
      setPassword("");
      if (data.syncPending) {
        setSyncingProvider(provider);
        setMessage(`${provider[0].toUpperCase() + provider.slice(1)} unlinking is completing.`);
        const resume = async (attempt = 0) => {
          if (!mounted.current) return;
          try {
            const retry = await fetch(
              `/api/auth/identities?flow=${encodeURIComponent(flow)}`,
              {
                cache: "no-store",
              }
            );
            const retryData = await retry.json().catch(() => ({}));
            if (!mounted.current) return;
            const retryProviders = new Set(retryData.unlinkableProviders || []);
            if (retry.ok && retryData.ok && !retryProviders.has(provider)) {
              setState({ ...retryData, loading: false });
              setSyncingProvider("");
              setMessage(`${provider[0].toUpperCase() + provider.slice(1)} was unlinked.`);
              return;
            }
          } catch {}
          if (!mounted.current) return;
          if (attempt < 71) {
            unlinkPollTimer.current = setTimeout(() => resume(attempt + 1), 5_000);
          } else {
            setSyncingProvider("");
            setMessage(
              `${provider[0].toUpperCase() + provider.slice(1)} is still linked. Confirm your identity again to retry.`
            );
          }
        };
        unlinkPollTimer.current = setTimeout(() => resume(), 5_000);
      } else {
        setState((current) => ({
          ...current,
          providers: (current.providers || []).filter((value) => value !== provider),
          unlinkableProviders: (current.unlinkableProviders || [])
            .filter((value) => value !== provider),
        }));
        setMessage(`${provider[0].toUpperCase() + provider.slice(1)} was unlinked.`);
      }
    } catch (error) {
      setMessage(error.message || "Unable to unlink this account.");
    } finally {
      setBusy(false);
    }
  };

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
        {managedProviders.map((provider) => (
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
            {linked.has(provider) && canUnlink && unlinkable.has(provider) ? (
              <button
                className={isTourney ? "tourney-owner-link" : "ml-2 underline underline-offset-2"}
                aria-label={`Unlink ${provider}`}
                disabled={busy || Boolean(syncingProvider)}
                onClick={() => unlink(provider)}
                type="button"
              >
                Unlink
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {linked.has("email") && (missing.length > 0 || connectedSocial.length > 0) ? (
        <div className={isTourney ? "tourney-connected-reauth" : "mt-4 flex flex-col gap-2 sm:flex-row"}>
          <input
            aria-label="Current password"
            autoComplete="current-password"
            className={isTourney ? "tourney-connected-input" : "min-h-[44px] flex-1 rounded-xl border border-line-input bg-surface-input px-3 text-sm text-ink"}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Current password"
            type="password"
            value={password}
          />
          <button
            className={isTourney ? "tourney-owner-button tourney-connected-confirm" : "rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"}
            disabled={busy || !password}
            onClick={confirmPassword}
            type="button"
          >
            Confirm identity
          </button>
        </div>
      ) : null}
      {missing.length > 0 && !linked.has("email") && connectedSocial.length > 0 ? (
        <SupabaseSocialLogin
          action="reauth"
          flow={flow}
          nextPath={nextPath}
          providerIds={connectedSocial}
          reauthPurpose="link_identity"
          variant={variant}
        />
      ) : null}
      {!linked.has("email") && canUnlink && connectedSocial.length > 0 ? (
        <SupabaseSocialLogin
          action="reauth"
          flow={flow}
          nextPath={nextPath}
          providerIds={connectedSocial.filter((provider) => unlinkable.has(provider))}
          reauthPurpose="unlink_identity"
          variant={variant}
        />
      ) : null}
      {recoveryProvider ? (
        <p className={isTourney ? "tourney-form-message" : "mt-3 text-xs leading-5 text-danger-text"} role="alert">
          {`${recoveryProvider[0].toUpperCase() + recoveryProvider.slice(1)} is held by an unused sign-in. Confirm your identity, then use Recover to release only that orphan and finish linking.`}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className={isTourney ? "tourney-form-message" : "mt-3 text-xs leading-5 text-ink-muted"}>
          {hasLinkProof
            ? `Link proof confirmed until ${proofExpiryLabel(linkProof.expiresAt)}. It will be used by the next link attempt.`
            : "Confirm your identity to enable provider linking."}
        </p>
      ) : null}
      {recoveryProvider ? (
        <SupabaseSocialLogin
          action="reclaim"
          flow={flow}
          linkProof={linkProof}
          nextPath={nextPath}
          onProofConsumed={() => {
            setLinkProof(null);
            setMessage("Identity confirmation used. Complete provider recovery to finish linking.");
          }}
          onProofFailure={() => {
            setLinkProof(null);
            setMessage("Identity confirmation could not be used. Confirm your identity again.");
          }}
          providerIds={[recoveryProvider]}
          variant={variant}
        />
      ) : null}
      {standardMissing.length > 0 ? (
        <SupabaseSocialLogin
          action="link"
          flow={flow}
          linkProof={linkProof}
          nextPath={nextPath}
          onProofConsumed={() => {
            setLinkProof(null);
            setMessage("Identity confirmation used. Complete provider sign-in to finish linking.");
          }}
          onProofFailure={() => {
            setLinkProof(null);
            setMessage("Identity confirmation could not be used. Confirm your identity again.");
          }}
          providerIds={standardMissing}
          variant={variant}
        />
      ) : null}
      {message ? (
        <p className={isTourney ? "tourney-form-message" : "mt-3 text-xs leading-5 text-ink-muted"} role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
