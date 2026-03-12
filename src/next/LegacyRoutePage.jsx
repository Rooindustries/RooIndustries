"use client";

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { AppContent } from "../App";

const buildQueryString = (searchParams) => {
  if (!searchParams || typeof searchParams !== "object") return "";
  const params = new URLSearchParams();

  Object.entries(searchParams).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null) {
          params.append(key, String(item));
        }
      });
      return;
    }

    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  });

  const query = params.toString();
  return query ? `?${query}` : "";
};

export default function LegacyRoutePage({
  pathname = "/",
  searchParams,
  initialRouteData = null,
}) {
  const query = buildQueryString(searchParams);
  // Keep initial server/client entry deterministic; hash intent is handled post-mount.
  const initialEntry = `${pathname}${query}`;

  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppContent initialRouteData={initialRouteData} routeShell="memory" />
    </MemoryRouter>
  );
}
