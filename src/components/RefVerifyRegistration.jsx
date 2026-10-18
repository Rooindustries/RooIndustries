import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from "../lib/browserStorage";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

const TOKEN_KEY = "referral_registration_verification";

const readFragmentToken = (hash) =>
  String(new URLSearchParams(String(hash || "").replace(/^#/, "")).get("token") || "").trim();

const readVerificationToken = ({ hash }) => {
  if (typeof window === "undefined") return "";
  const fragmentToken = readFragmentToken(hash);
  if (fragmentToken) writeBrowserStorage("sessionStorage", TOKEN_KEY, fragmentToken);
  return fragmentToken || readBrowserStorage("sessionStorage", TOKEN_KEY) || "";
};

export default function RefVerifyRegistration() {
  const location = useLocation();
  const navigate = useNavigate();
  const requests = useRef(new Map());
  const currentToken = useRef("");
  const [verificationLocation, setVerificationLocation] = useState(() => ({
    hash:
      (typeof window !== "undefined" ? window.location.hash : "") ||
      location.hash ||
      "",
    pathname: location.pathname,
    search:
      (typeof window !== "undefined" ? window.location.search : "") ||
      location.search ||
      "",
  }));
  const [state, setState] = useState({ status: "working", message: "Confirming your email…" });

  useEffect(() => {
    const adoptLink = () => {
      const next = {
        hash: window.location.hash,
        pathname: window.location.pathname,
        search: window.location.search,
      };
      if (next.pathname !== verificationLocation.pathname || !readFragmentToken(next.hash)) return;
      setVerificationLocation(next);
    };
    window.addEventListener("hashchange", adoptLink);
    return () => window.removeEventListener("hashchange", adoptLink);
  }, [verificationLocation.pathname]);

  useEffect(() => {
    const token = readVerificationToken(verificationLocation);
    if (
      window.location.pathname === verificationLocation.pathname &&
      (verificationLocation.hash || verificationLocation.search)
    ) {
      window.history.replaceState(
        window.history.state,
        "",
        verificationLocation.pathname
      );
    }
    currentToken.current = token;
    if (!token) {
      setState({ status: "error", message: "This confirmation link is missing or invalid." });
      return;
    }
    const releaseStoredToken = () => {
      if (readBrowserStorage("sessionStorage", TOKEN_KEY) === token) {
        removeBrowserStorage("sessionStorage", TOKEN_KEY);
      }
    };
    let request = requests.current.get(token);
    if (!request || request.outcome?.status === "error") {
      const entry = { outcome: null };
      entry.promise = fetch("/api/ref/verifyRegistration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then(async (response) => ({
          ok: response.ok,
          status: response.status,
          data: await response.json().catch(() => ({})),
        }))
        .then(({ ok, status, data }) => {
          if (!ok || data.ok !== true) {
            if (status === 400) releaseStoredToken();
            return {
              status: "error",
              message: data.error || "This confirmation link is invalid or expired.",
            };
          }
          releaseStoredToken();
          return {
            status: "success",
            requiresLogin: data.requiresLogin === true,
            message: data.requiresLogin === true
              ? "Your account is confirmed. Sign in to open your creator dashboard."
              : "Email confirmed. Your creator account is ready.",
          };
        })
        .catch(() => ({ status: "error", message: "Confirmation is temporarily unavailable. Please try again." }))
        .then((outcome) => {
          entry.outcome = outcome;
          return outcome;
        });
      requests.current.set(token, entry);
      request = entry;
    }
    if (request.outcome) {
      releaseStoredToken();
      setState(request.outcome);
      return;
    }
    setState({ status: "working", message: "Confirming your email…" });
    request.promise.then((outcome) => {
      if (currentToken.current === token) setState(outcome);
    });
  }, [verificationLocation]);

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
        {state.status === "success" && state.requiresLogin ? (
          <Link
            className="mt-6 block w-full rounded-xl bg-accent-strong py-3 font-semibold text-white"
            to="/referrals/login?notice=email-confirmed"
          >
            Sign in
          </Link>
        ) : state.status === "success" ? (
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
