"use client";

import Page from "../../legacyPages/Terms";
import LegacyRoutePage from "../LegacyRoutePage";

export default function RouteEntry(props) {
  return <LegacyRoutePage {...props} initialRouteComponent={Page} />;
}
