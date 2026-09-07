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
    const tick = async () => {
      if (pending) return;
      pending = true;
      const versionAtStart = versionRef.current;
      try {
        const response = await fetch("/api/tourney/bracket", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        if (!active || body?.ok !== true) return;
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
        pending = false;
      }
    };

    const id = setInterval(tick, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return [snapshot, setSnapshot];
};
