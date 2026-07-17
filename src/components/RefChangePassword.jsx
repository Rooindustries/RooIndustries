import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const PASSWORD_PENDING_MESSAGE =
  "Your password change is saving. It will finish in a moment.";
const PASSWORD_UPDATED_MESSAGE =
  "Password updated. Log in with your new password.";

export default function RefChangePassword() {
  const nav = useNavigate();
  const [sessionChecked, setSessionChecked] = useState(false);

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch("/api/ref/getData");
        const data = await res.json();
        if (!data.ok) {
          nav("/referrals/login");
          return;
        }
      } catch {
        console.error("Referral session validation failed");
        nav("/referrals/login");
        return;
      } finally {
        setSessionChecked(true);
      }
    };
    checkSession();
  }, [nav]);

  if (!sessionChecked) return null;

  async function update() {
    if (!currentPassword || !pass1 || !pass2) {
      setOutcome({ type: "error", message: "Fill in all three fields." });
      return;
    }
    if (pass1 !== pass2) {
      setOutcome({ type: "error", message: "Passwords do not match." });
      return;
    }
    if (pass1.length < 10 || pass1.length > 128) {
      setOutcome({
        type: "error",
        message: "Use a password between 10 and 128 characters.",
      });
      return;
    }

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
        setOutcome({
          type: "error",
          message: reauth.error || "Current password is incorrect.",
        });
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
          nav("/referrals/login");
          return;
        }
        setOutcome({
          type: "error",
          message: data.error || "Password update could not be completed.",
        });
        return;
      }

      setOutcome({
        type: "success",
        message: data.message || PASSWORD_UPDATED_MESSAGE,
      });
      setCurrentPassword("");
      setPass1("");
      setPass2("");
      setTimeout(
        () => nav("/referrals/login?notice=password-updated"),
        1500
      );
    } catch {
      console.error("Referral password change failed");
      setOutcome({
        type: "error",
        message: "Password update could not be completed. Please try again.",
      });
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
          <label className="text-accent text-sm font-semibold">
            Current Password
          </label>
          <input
            autoComplete="current-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Enter current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>

        <div>
          <label className="text-accent text-sm font-semibold">
            New Password
          </label>
          <input
            autoComplete="new-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Enter new password"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
          />
        </div>

        <div>
          <label className="text-accent text-sm font-semibold">
            Confirm Password
          </label>
          <input
            autoComplete="new-password"
            type="password"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base"
            placeholder="Confirm new password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
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
