"use client";

import React, { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { AppContent } from "../App";
import { buildQueryString } from "./routeQuery";
import { sanitizeBrowserSearch } from "../lib/browserSearch";

export default function LegacyRoutePage({
  pathname = "/",
  searchParams,
  initialHomeData = null,
  initialRouteData = null,
  initialRouteComponent = null,
  initialHomeComponent = null,
  initialBookingModalComponent = null,
  notFound = false,
}) {
  const [initialEntry] = useState(() => {
    const serverQuery = sanitizeBrowserSearch(pathname, buildQueryString(searchParams));
    const query = !serverQuery && typeof window !== "undefined" && window.location.pathname === pathname
      ? sanitizeBrowserSearch(pathname, window.location.search)
      : serverQuery;
    return `${pathname}${query}`;
  });

  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppContent
        initialHomeData={initialHomeData}
        initialRouteData={initialRouteData}
        initialRouteComponent={initialRouteComponent}
        initialHomeComponent={initialHomeComponent}
        initialBookingModalComponent={initialBookingModalComponent}
        initialRoutePath={pathname}
        routeShell="memory"
        notFound={notFound}
      />
    </MemoryRouter>
  );
}
