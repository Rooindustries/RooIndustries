"use client";

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { AppContent } from "../App";
import { buildQueryString } from "./routeQuery";

const isFlowPath = (pathname = "") =>
  pathname.startsWith("/booking") ||
  pathname === "/payment" ||
  pathname.startsWith("/payment-success") ||
  pathname.startsWith("/thank-you");

export default function LegacyRoutePage({
  pathname = "/",
  searchParams,
  initialHomeData = null,
}) {
  const flowRoute = isFlowPath(pathname);
  const [shouldRender, setShouldRender] = React.useState(() => !flowRoute);
  const query = buildQueryString(searchParams);
  // Keep initial server/client entry deterministic; hash intent is handled post-mount.
  const initialEntry = `${pathname}${query}`;

  React.useEffect(() => {
    if (flowRoute) setShouldRender(true);
  }, [flowRoute]);

  if (!shouldRender) return null;

  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppContent initialHomeData={initialHomeData} routeShell="memory" />
    </MemoryRouter>
  );
}
