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
    const tick = async () => {
      try {
        const response = await fetch("/api/tourney/bracket", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        if (!active || body?.ok !== true) return;
        const nextVersion = snapshotVersion(body);
        if (nextVersion && nextVersion !== versionRef.current) setSnapshot(body);
      } catch {
        // Keep the last good bracket visible and retry on the next interval.
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
