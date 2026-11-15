import React, { useSyncExternalStore } from "react";
import { useRouteSwitch } from "../next/PendingMemoryRouter";
import { useIsomorphicLayoutEffect } from "../lib/useIsomorphicLayoutEffect";

let waiting = 0;
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const setWaiting = (change) => {
  waiting += change;
  listeners.forEach((listener) => listener());
};

export function RouteWaiting() {
  useIsomorphicLayoutEffect(() => {
    setWaiting(1);
    return () => setWaiting(-1);
  }, []);
  return null;
}

export default function RouteProgress() {
  const { pending } = useRouteSwitch();
  const held = useSyncExternalStore(subscribe, () => waiting > 0, () => false);
  const loading = pending || held;

  useIsomorphicLayoutEffect(() => {
    if (!loading) return undefined;
    const root = document.documentElement;
    root.dataset.routePending = "";
    return () => {
      delete root.dataset.routePending;
    };
  }, [loading]);

  return (
    <div
      className="route-progress fixed inset-x-0 top-0 z-[100] pointer-events-none"
      data-state={loading ? "loading" : "idle"}
      role={loading ? "progressbar" : undefined}
      aria-label={loading ? "Loading page" : undefined}
      aria-hidden={loading ? undefined : "true"}
    >
      <span className="route-progress-segment" />
    </div>
  );
}
