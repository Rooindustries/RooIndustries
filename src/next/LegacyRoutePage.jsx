"use client";

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { AppContent } from "../App";
import { buildQueryString } from "./routeQuery";

export default function LegacyRoutePage({
  pathname = "/",
  searchParams,
  initialHomeData = null,
}) {
  const query = buildQueryString(searchParams);
  // Keep initial server/client entry deterministic; hash intent is handled post-mount.
  const initialEntry = `${pathname}${query}`;

  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppContent initialHomeData={initialHomeData} routeShell="memory" />
    </MemoryRouter>
  );
}
