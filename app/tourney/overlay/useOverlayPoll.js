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
    let pending = false;
    let activeController;
    let activeTimeout;
    const tick = async () => {
      if (pending) return;
      pending = true;
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      activeTimeout = timeout;
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const body = await response.json();
        if (!active || controller.signal.aborted || !body?.ok) return;
        if (body.version && body.version !== versionRef.current) {
          onUpdateRef.current(body);
        }
      } catch {
        // Keep the last good render on stream; retry next tick.
      } finally {
        clearTimeout(timeout);
        activeController = undefined;
        pending = false;
      }
    };
    const id = setInterval(tick, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
      clearTimeout(activeTimeout);
      activeController?.abort();
    };
  }, [url, intervalMs, enabled]);
};
