"use client";

import { useEffect, useRef } from "react";

export const useOverlayPoll = ({ url, intervalMs, version, onUpdate, enabled = true }) => {
  const versionRef = useRef(version);
  versionRef.current = version;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!enabled || !url || !intervalMs) return undefined;
    let active = true;
    const tick = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        if (!active || !body?.ok) return;
        if (body.version && body.version !== versionRef.current) {
          onUpdateRef.current(body);
        }
      } catch {
        // Keep the last good render on stream; retry next tick.
      }
    };
    const id = setInterval(tick, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [url, intervalMs, enabled]);
};
