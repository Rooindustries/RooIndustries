import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isValidNewPassword, NEW_PASSWORD_REQUIREMENT } from "../lib/passwordPolicy";
import { useReferralAccount } from "../lib/useReferralAccount";

const PASSWORD_PENDING_MESSAGE =
  "Your password change is saving. It will finish in a moment.";
const PASSWORD_UPDATED_MESSAGE =
  "Password updated. Log in with your new password.";

export default function RefChangePassword() {
  const nav = useNavigate();
  const { referral, loading: checking, error: accountError, retry } = useReferralAccount();

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const editVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const navTimerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(navTimerRef.current);
    };
  }, []);

  if (checking) return <p role="status" className="pt-32 text-center text-ink">Checking your account...</p>;
  if (accountError) return (
    <section className="pt-32 px-6 max-w-xl mx-auto text-ink">
      <h1 className="text-3xl font-bold text-accent">Change Password</h1>
      <p role="alert" className="mt-4 text-danger-text">{accountError}</p>
      <button onClick={retry} className="mt-6 rounded-xl bg-accent-strong px-6 py-3 font-semibold text-accent-contrast">Retry</button>
    </section>
  );
  if (!referral) return null;

  async function update() {
    if (!currentPassword || !pass1 || !pass2) {
      setOutcome({ type: "error", message: "Fill in all three fields." });
      return;
    }
    if (pass1 !== pass2) {
      setOutcome({ type: "error", message: "Passwords do not match." });
      return;
    }
    if (!isValidNewPassword(pass1)) {
      setOutcome({
        type: "error",
        message: NEW_PASSWORD_REQUIREMENT,
      });
      return;
    }

    const version = editVersionRef.current;
    setLoading(true);
    setOutcome(null);

    try {
      const reauthResponse = await fetch("/api/auth/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow: "referral",
          password: currentPassword,
          purpose: "change_password",
        }),
      });
      const reauth = await reauthResponse.json().catch(() => ({}));
      if (!reauthResponse.ok || !reauth.ok) {
        if (reauth.reason === "password_incorrect") {
          if (editVersionRef.current === version) {
            setOutcome({
              type: "error",
              message: reauth.error || "Current password is incorrect.",
            });
          }
        } else {
          setOutcome({
            type: "error",
            kind: "service",
            message: reauth.error || "We couldn't confirm your current password. Please try again.",
          });
        }
        return;
      }
      const res = await fetch("/api/ref/hashPassword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass1 }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 202 || data.status === "pending") {
        setOutcome({
          type: "pending",
          message: data.message || PASSWORD_PENDING_MESSAGE,
        });
        return;
      }

      if (!res.ok || !data.ok) {
        if (res.status === 401) {
          if (mountedRef.current) nav("/referrals/login");
          return;
        }
        if (editVersionRef.current === version) {
          setOutcome({
            type: "error",
            message: data.error || "Password update could not be completed.",
          });
        }
        return;
      }

      setOutcome({
        type: "success",
        message: data.message || PASSWORD_UPDATED_MESSAGE,
      });
      setCurrentPassword("");
      setPass1("");
      setPass2("");
      if (mountedRef.current) {
        navTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          nav("/referrals/login?notice=password-updated");
        }, 1500);
      }
    } catch {
      console.error("Referral password change failed");
      if (editVersionRef.current === version) {
        setOutcome({
          type: "error",
          message: "Password update could not be completed. Please try again.",
        });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Change Password
      </h1>

      <div
        className="mt-10 w-full max-w-md bg-surface-card backdrop-blur-xl
                      border border-line-input shadow-[var(--shadow-card-glow)]
                      rounded-2xl p-8 space-y-6"
      >
        <div>
          <label
            htmlFor="ref-change-current-password"
            className="text-accent text-sm font-semibold"
          >
            Current Password
          </label>
          <input
            id="ref-change-current-password"
            autoComplete="current-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Enter current password"
            value={currentPassword}
            onChange={(e) => {
              editVersionRef.current += 1;
              setOutcome(current => current?.type === "error" && current.kind !== "service" ? null : current);
              setCurrentPassword(e.target.value);
            }}
          />
        </div>

        <div>
          <label
            htmlFor="ref-change-new-password"
            className="text-accent text-sm font-semibold"
          >
            New Password
          </label>
          <input
            id="ref-change-new-password"
            autoComplete="new-password"
            type="password"
            aria-describedby="ref-change-password-requirement"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Enter new password"
            value={pass1}
            onChange={(e) => {
              editVersionRef.current += 1;
              setOutcome(current => current?.type === "error" && current.kind !== "service" ? null : current);
              setPass1(e.target.value);
            }}
          />
          <p id="ref-change-password-requirement" className="mt-2 text-xs text-ink-muted">
            {NEW_PASSWORD_REQUIREMENT}
          </p>
        </div>

        <div>
          <label
            htmlFor="ref-change-confirm-password"
            className="text-accent text-sm font-semibold"
          >
            Confirm Password
          </label>
          <input
            id="ref-change-confirm-password"
            autoComplete="new-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Confirm new password"
            value={pass2}
            onChange={(e) => {
              editVersionRef.current += 1;
              setOutcome(current => current?.type === "error" && current.kind !== "service" ? null : current);
              setPass2(e.target.value);
            }}
          />
        </div>

        {outcome ? (
          <div
            aria-live="polite"
            className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
              outcome.type === "success"
                ? "border-success-border bg-success-soft text-success-text"
                : outcome.type === "pending"
                  ? "border-warning-border bg-warning-soft text-warning-text"
                  : "border-danger-border bg-danger-soft text-danger-text"
            }`}
            role={outcome.type === "error" ? "alert" : "status"}
          >
            {outcome.message}
          </div>
        ) : null}

        <button
          onClick={update}
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all
            ${
              loading
                ? "bg-surface-input opacity-40 cursor-not-allowed"
                : "bg-accent-strong hover:bg-accent text-accent-contrast shadow-glow-soft"
            }
          `}
        >
          {loading ? "Saving..." : "Save Password"}
        </button>

        <button
          type="button"
          onClick={() => nav("/referrals/dashboard")}
          className="w-full text-sm text-accent opacity-80 hover:opacity-100 mt-2"
        >
          Back to Dashboard
        </button>
      </div>

    </section>
  );
}
