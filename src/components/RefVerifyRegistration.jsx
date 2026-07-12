import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const TOKEN_KEY = "referral_registration_verification";

export default function RefVerifyRegistration() {
  const location = useLocation();
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState({ status: "working", message: "Confirming your email…" });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    const fragmentToken = String(fragment.get("token") || "").trim();
    if (fragmentToken) sessionStorage.setItem(TOKEN_KEY, fragmentToken);
    const token = fragmentToken || sessionStorage.getItem(TOKEN_KEY) || "";
    if (location.hash || location.search) {
      navigate(location.pathname, { replace: true });
    }
    if (!token) {
      setState({ status: "error", message: "This confirmation link is missing or invalid." });
      return;
    }
    fetch("/api/ref/verifyRegistration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => ({
        ok: response.ok,
        data: await response.json().catch(() => ({})),
      }))
      .then(({ ok, data }) => {
        if (!ok || data.ok !== true) {
          setState({
            status: "error",
            message: data.error || "This confirmation link is invalid or expired.",
          });
          return;
        }
        sessionStorage.removeItem(TOKEN_KEY);
        setState({ status: "success", message: "Email confirmed. Your creator account is ready." });
      })
      .catch(() => {
        setState({ status: "error", message: "Confirmation is temporarily unavailable. Please try again." });
      });
  }, [location.hash, location.pathname, location.search, navigate]);

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <div className="w-full max-w-md rounded-2xl border border-line-input bg-surface-card p-8 text-center shadow-[var(--shadow-card-glow)]">
        <h1 className="text-3xl font-extrabold text-accent">Confirm creator account</h1>
        <p
          className={state.status === "error" ? "mt-4 text-danger-text" : "mt-4 text-ink-secondary"}
          role="status"
        >
          {state.message}
        </p>
        {state.status === "success" ? (
          <button
            className="mt-6 w-full rounded-xl bg-accent-strong py-3 font-semibold text-white"
            onClick={() => navigate("/referrals/dashboard")}
            type="button"
          >
            Open dashboard
          </button>
        ) : null}
        {state.status === "error" ? (
          <button
            className="mt-6 w-full rounded-xl border border-line-input py-3 font-semibold text-accent"
            onClick={() => navigate("/referrals/register")}
            type="button"
          >
            Back to registration
          </button>
        ) : null}
      </div>
    </section>
  );
}
