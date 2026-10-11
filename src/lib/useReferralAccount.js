import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { removeBrowserStorage } from "./browserStorage";

export function useReferralAccount() {
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ referral: null, loading: true, error: "" });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setState(previous => ({ ...previous, loading: true, error: "" }));

    async function load() {
      try {
        const response = await fetch("/api/ref/getData", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!active) return;
        if (response.status === 401) {
          removeBrowserStorage("sessionStorage", "creatorId");
          navigate("/referrals/login");
          return;
        }
        if (!response.ok || !data.ok || !data.referral) {
          setState(previous => ({ ...previous, error: data.error || "Could not load your account. Please try again." }));
          return;
        }
        setState({ referral: data.referral, loading: false, error: "" });
      } catch {
        if (active) setState(previous => ({ ...previous, error: "Could not load your account. Please try again." }));
      } finally {
        clearTimeout(timeout);
        if (active) setState(previous => ({ ...previous, loading: false }));
      }
    }

    load();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, navigate]);

  return { ...state, retry: () => setAttempt(previous => previous + 1) };
}
