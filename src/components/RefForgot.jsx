import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RefForgot() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [formError, setFormError] = useState("");
  const [acknowledgedEmail, setAcknowledgedEmail] = useState("");
  const submittedEmailRef = useRef("");
  const acknowledged = Boolean(acknowledgedEmail) && email === acknowledgedEmail;
  const statusRef = useRef(null);

  useEffect(() => {
    if (acknowledged) statusRef.current?.scrollIntoView({ block: "nearest" });
  }, [acknowledged]);

  function showToast(type, message) {
    const next = { type, message };
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 3000);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    if (!email) return setFormError("Enter your email");

    const submittedEmail = email;
    submittedEmailRef.current = submittedEmail;
    setLoading(true);
    setAcknowledgedEmail("");
    setToast(null);

    try {
      const res = await fetch("/api/ref/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submittedEmail }),
      });

      const data = await res.json();

      if (data.ok) {
        if (submittedEmailRef.current === submittedEmail) setAcknowledgedEmail(submittedEmail);
      } else {
        if (submittedEmailRef.current === submittedEmail) setFormError(data.error || "Failed to send link");
      }
    } catch {
      console.error("Referral reset request failed");
      if (submittedEmailRef.current === submittedEmail) setFormError("Server error.");
    }

    setLoading(false);
  }

  return (
    <section className="pt-32 px-6 min-h-screen text-ink flex flex-col items-center">
      <h1 className="text-4xl font-extrabold text-center text-accent drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Forgot Password
      </h1>

      <p className="text-ink-muted mt-3 text-center max-w-md text-base">
        Enter the email attached to your referral account and we&apos;ll send
        you a reset link.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-10 w-full max-w-md
                  bg-surface-card backdrop-blur-xl
                  border border-line-input
                  shadow-[var(--shadow-card-glow)]
                  rounded-2xl p-8 space-y-6"
      >
        <div>
          <label htmlFor="ref-forgot-email" className="text-accent text-sm font-semibold">
            Creator Email
          </label>
          <input
            id="ref-forgot-email"
            name="email"
            autoComplete="email"
            type="email"
            className="w-full p-4 mt-1 bg-surface-input border border-line-input rounded-xl
                       outline-none focus:border-info-border transition text-base text-ink"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setFormError("");
              submittedEmailRef.current = "";
              setAcknowledgedEmail("");
              setEmail(e.target.value.trim());
            }}
          />
        </div>

        {acknowledged && (
          <p ref={statusRef} role="status" className="rounded-xl border border-success-border bg-success-soft p-4 text-sm text-success-text">
            If an account matches that email, we've sent a reset link. Check your inbox and spam folder.
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className={`w-full py-4 rounded-xl font-bold text-lg transition-all ${
            loading
              ? "bg-surface-input opacity-40 cursor-not-allowed"
              : "bg-accent-strong hover:bg-accent text-accent-contrast shadow-glow-soft"
          }`}
        >
          {loading ? "Sending..." : "Send Reset Link"}
        </button>
        {formError && (
          <p role="alert" className="text-sm text-danger-text">{formError}</p>
        )}

        <button
          type="button"
          onClick={() => nav("/referrals/login")}
          className="w-full text-sm text-accent opacity-80 hover:opacity-100 mt-1"
        >
          Back to Login
        </button>
      </form>

      {toast && (
        <div
          role={toast.type === "error" ? "alert" : "status"}
          aria-atomic="true"
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-lg transition-all ${
            toast.type === "success"
              ? "bg-success shadow-success-soft"
              : "bg-danger shadow-danger-soft"
          }`}
        >
          {toast.message}
        </div>
      )}
    </section>
  );
}
