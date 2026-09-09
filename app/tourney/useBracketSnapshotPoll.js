"use client";

import { useEffect, useRef, useState } from "react";

const snapshotVersion = (snapshot) =>
  String(snapshot?.meta?.updatedAt || snapshot?.meta?.updated_at || "");

export const useBracketSnapshotPoll = (initialSnapshot, intervalMs = 5000) => {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const versionRef = useRef(snapshotVersion(initialSnapshot));
  versionRef.current = snapshotVersion(snapshot);

  useEffect(() => {
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
      const versionAtStart = versionRef.current;
      try {
        const response = await fetch("/api/tourney/bracket", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const body = await response.json();
        if (!active || controller.signal.aborted || body?.ok !== true) return;
        const nextVersion = snapshotVersion(body);
        if (nextVersion) {
          // A successful command may have installed a newer snapshot while
          // this read was pending. Preserve that command result.
          setSnapshot((current) =>
            snapshotVersion(current) === versionAtStart &&
            nextVersion !== versionAtStart
              ? body
              : current
          );
        }
      } catch {
        // Keep the last good bracket visible and retry on the next interval.
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
  }, [intervalMs]);

  return [snapshot, setSnapshot];
};
