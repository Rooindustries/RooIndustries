import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefChangePassword() {
  const nav = useNavigate();
  const [sessionChecked, setSessionChecked] = useState(false);

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

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

  function showToast(type, msg) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 2200);
  }

  async function update() {
    if (!currentPassword || !pass1 || !pass2) {
      return showToast("error", "Fill in all three fields");
    }
    if (pass1 !== pass2) return showToast("error", "Passwords do not match");

    setLoading(true);

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
        setLoading(false);
        return showToast("error", reauth.error || "Current password is incorrect");
      }
      const res = await fetch("/api/ref/hashPassword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass1 }),
      });

      const data = await res.json();

      if (!data.ok) {
        if (res.status === 401) {
          nav("/referrals/login");
          return;
        }
        setLoading(false);
        return showToast("error", data.error || "Failed to update password");
      }

      showToast("success", "Password updated!");
      setCurrentPassword("");
      setPass1("");
      setPass2("");
      setTimeout(() => nav("/referrals/login"), 1200);
    } catch {
      console.error("Referral password change failed");
      showToast("error", "Server error");
    }

    setLoading(false);
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

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl 
          text-white text-sm font-semibold shadow-lg transition-all
          ${
            toast.type === "success"
              ? "bg-success shadow-success-soft"
              : "bg-danger shadow-danger-soft"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </section>
  );
}
